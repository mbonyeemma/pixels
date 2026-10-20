import nacl from 'tweetnacl';
import {
  DEVNET_GENESIS_HASH,
  DEVNET_LABEL,
  PAY_INTENT_TTL_MS,
  hasLamportPrice,
  itemById,
  type PayConfirmResponse,
  type PayIntentView,
  type PaymentConfigView,
  type ServerMessage,
} from '@pixels/shared';
import type { AccountRecord, Database, PaymentIntentRecord } from '../db';
import type { Logger } from '../log';
import type { Shop } from '../shop';
import { randomHex, type Clock } from '../util';
import { encodeBase58, isValidSignature } from './base58';
import { RpcError, type PaymentsConfig, type SolanaRpc } from './types';
import { verifyPaymentTransaction } from './verify';

/** A payment may be confirmed this long after the deadline as long as the transaction itself was made in time. */
export const CONFIRM_GRACE_MS = 5 * 60_000;
/** A pending intent is handed out again (instead of minting a new one) while at least this much time is left. */
const REUSE_MIN_REMAINING_MS = 60_000;
const CLUSTER_RECHECK_MS = 60 * 60_000;
const RETRY_DELAY_MS = 1500;
const MAX_ATTEMPTS = 20;

export interface PayError {
  ok: false;
  status: number;
  code: string;
  error: string;
  /** the transaction is not visible yet: ask again shortly (HTTP 202) */
  pending?: boolean;
}
export type IntentResult = { ok: true; intent: PayIntentView } | PayError;
export type ConfirmResult = ({ ok: true } & PayConfirmResponse) | PayError;
export type ClusterState = 'ok' | 'blocked' | 'unreachable';

export interface PaymentsDeps {
  config: PaymentsConfig;
  db: Database;
  shop: Shop;
  rpc: SolanaRpc;
  clock: Clock;
  log: Logger;
  /** push a message to the player's live connection, if any */
  notify: (accountId: string, msg: ServerMessage) => void;
  /** injectable pause between look-ups (tests advance a fake clock here) */
  sleep?: (ms: number) => Promise<void>;
}

const e = (status: number, code: string, error: string, extra: Partial<PayError> = {}): PayError => ({ ok: false, status, code, error, ...extra });

/**
 * Optional Solana Devnet payments: pay intents and on-chain verification. Nothing is ever granted unless the
 * transaction was fetched from the (Devnet) node and passed every check in verify.ts; the amount always comes from
 * the server catalogue. This class holds no secrets: only the treasury PUBLIC key.
 */
export class SolanaPayments {
  private cluster: { state: ClusterState; at: number } = { state: 'unreachable', at: 0 };
  private clusterCheck: Promise<ClusterState> | null = null;
  private readonly inflight = new Map<string, Promise<ConfirmResult>>();
  private readonly sleep: (ms: number) => Promise<void>;
  readonly treasury: string;

  constructor(private readonly deps: PaymentsDeps) {
    if (!deps.config.enabled || !deps.config.treasury) throw new Error('SolanaPayments needs an enabled config with a treasury public key.');
    this.treasury = deps.config.treasury;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (deps.config.tokenMint) {
      deps.log.warn('SOLANA_TOKEN_MINT is set but SPL token pricing is not implemented: payments are SOL only (Devnet)');
    }
  }

  /** What GET /api/config reports while payments are usable. */
  configView(): PaymentConfigView {
    return { enabled: this.cluster.state !== 'blocked', cluster: 'devnet', treasury: this.treasury, tokenMint: null };
  }

  get clusterState(): ClusterState {
    return this.cluster.state;
  }

  /**
   * Cluster guard: the RPC node must serve Solana Devnet (genesis hash). 'blocked' is sticky: payments stay off until
   * the server is restarted with a correct SOLANA_RPC_URL. 'unreachable' is retried on the next call.
   */
  ensureDevnet(): Promise<ClusterState> {
    const now = this.deps.clock();
    if (this.cluster.state === 'blocked') return Promise.resolve('blocked');
    if (this.cluster.state === 'ok' && now - this.cluster.at < CLUSTER_RECHECK_MS) return Promise.resolve('ok');
    if (this.clusterCheck) return this.clusterCheck;
    this.clusterCheck = (async (): Promise<ClusterState> => {
      try {
        const genesis = await this.deps.rpc.getGenesisHash();
        if (genesis === DEVNET_GENESIS_HASH) {
          this.cluster = { state: 'ok', at: this.deps.clock() };
        } else {
          this.cluster = { state: 'blocked', at: this.deps.clock() };
          this.deps.log.error('payments DISABLED: the RPC node is not Solana Devnet (genesis hash mismatch)', { genesis });
        }
      } catch (err) {
        this.cluster = { state: 'unreachable', at: this.deps.clock() };
        this.deps.log.warn('could not verify the Solana cluster yet', { err });
      }
      return this.cluster.state;
    })().finally(() => {
      this.clusterCheck = null;
    });
    return this.clusterCheck;
  }

  /* --------------------------------------------------------------- intents */

  createIntent(account: AccountRecord, itemId: string): IntentResult {
    if (this.cluster.state === 'blocked') return e(503, 'cluster_guard', 'Payments are switched off because the configured network is not Solana Devnet.');
    if (!account.wallet) return e(409, 'wallet_required', 'Link a Solana wallet to your account before paying with SOL.');
    const item = itemById(itemId);
    if (!item) return e(404, 'unknown_item', 'That item does not exist.');
    if (!hasLamportPrice(item)) return e(400, 'not_payable', `${item.name} cannot be paid for with Devnet SOL.`);
    const grantable = this.deps.shop.checkGrantable(account, item);
    if (!grantable.ok) return e(409, 'already_owned', grantable.error);

    const now = this.deps.clock();
    this.deps.db.pruneIntents(now);
    // a retry (e.g. the player closed the wallet popup) gets the same pending request back instead of a new one
    const existing = this.deps.db
      .intentsOf(account.id)
      .find(
        (i) =>
          i.status === 'pending' &&
          i.itemId === item.id &&
          i.lamports === item.priceLamports &&
          i.payer === account.wallet &&
          i.treasury === this.treasury &&
          i.expiresAt - now >= REUSE_MIN_REMAINING_MS,
      );
    if (existing) return { ok: true, intent: this.view(existing) };

    const id = randomHex(16);
    const keys = nacl.sign.keyPair(); // only the public half is used; the secret half is zeroed and discarded
    const reference = encodeBase58(keys.publicKey);
    keys.secretKey.fill(0);
    const rec: PaymentIntentRecord = {
      id,
      accountId: account.id,
      itemId: item.id,
      lamports: item.priceLamports,
      payer: account.wallet,
      treasury: this.treasury,
      reference,
      memo: `pixels:${id}`,
      createdAt: now,
      expiresAt: now + PAY_INTENT_TTL_MS,
      status: 'pending',
    };
    this.deps.db.putIntent(rec);
    this.deps.log.info('pay intent created', { account: account.id, intent: id, item: item.id, lamports: rec.lamports });
    return { ok: true, intent: this.view(rec) };
  }

  private view(i: PaymentIntentRecord): PayIntentView {
    return { intentId: i.id, itemId: i.itemId, lamports: i.lamports, treasury: i.treasury, reference: i.reference, memo: i.memo, expiresAt: i.expiresAt, cluster: 'devnet' };
  }

  /* --------------------------------------------------------------- confirm */

  async confirm(account: AccountRecord, intentId: string, signature: string): Promise<ConfirmResult> {
    // a second request for the same intent waits for the first, then re-evaluates (idempotent, never double-grants)
    const prior = this.inflight.get(intentId);
    if (prior) {
      await prior.catch(() => undefined);
      return this.confirm(account, intentId, signature);
    }
    const run = this.doConfirm(account, intentId, signature);
    this.inflight.set(intentId, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(intentId);
    }
  }

  private fulfilledResult(intent: PaymentIntentRecord, signature: string): ConfirmResult {
    const item = itemById(intent.itemId);
    if (intent.status === 'paid_not_granted') {
      return e(409, 'paid_not_granted', `Your payment was verified but ${item?.name ?? 'the item'} could not be added (you may already own it). It was not refunded automatically in this test build.`);
    }
    return { ok: true, item: { id: intent.itemId, name: item?.name ?? intent.itemId }, signature };
  }

  private async doConfirm(account: AccountRecord, intentId: string, signature: string): Promise<ConfirmResult> {
    const { db, log } = this.deps;
    const reject = (r: PayError, intent?: PaymentIntentRecord): PayError => {
      log.warn('pay confirm rejected', { account: account.id, intent: intent?.id ?? intentId, code: r.code });
      return r;
    };
    if (!isValidSignature(signature)) return e(400, 'bad_signature', 'That is not a valid Solana transaction signature.');

    const intent = db.getIntent(intentId);
    if (!intent || intent.accountId !== account.id) return e(404, 'unknown_intent', 'That payment request does not exist.');

    // already settled: the same signature gets the same answer again; any other signature is refused
    if (intent.status !== 'pending') {
      return intent.signature === signature
        ? this.fulfilledResult(intent, signature)
        : reject(e(409, 'already_fulfilled', 'This payment request was already settled with a different transaction.'), intent);
    }
    const now = this.deps.clock();
    if (now > intent.expiresAt + CONFIRM_GRACE_MS) return reject(e(410, 'intent_expired', 'This payment request has expired. Start a new payment.'), intent);

    const used = db.findSignature(signature);
    if (used) return reject(e(409, 'signature_reused', 'That transaction was already used for a payment.'), intent);
    if (account.wallet !== intent.payer) {
      return reject(e(409, 'wallet_changed', 'Your linked wallet changed after this payment was requested. Start a new payment.'), intent);
    }

    const guard = await this.ensureDevnet();
    if (guard === 'blocked') return e(503, 'cluster_guard', 'Payments are switched off because the configured network is not Solana Devnet.');
    if (guard === 'unreachable') return e(503, 'rpc_unavailable', 'Could not reach Solana Devnet to check your payment. Try again in a moment.', { pending: true });

    let tx;
    try {
      tx = await this.fetchTransaction(signature);
    } catch (err) {
      log.warn('pay confirm: rpc error', { account: account.id, intent: intent.id, err });
      return e(503, 'rpc_unavailable', 'Could not reach Solana Devnet to check your payment. Try again in a moment.', { pending: true });
    }
    if (!tx) {
      return e(202, 'pending', 'The transaction is not visible on Solana Devnet yet. It may still be confirming; try again in a few seconds.', { pending: true });
    }

    // ---- everything below runs synchronously: check -> grant -> ledger cannot interleave with another request ----
    const fresh = db.getIntent(intentId);
    if (!fresh || fresh.status !== 'pending') {
      return fresh && fresh.signature === signature ? this.fulfilledResult(fresh, signature) : reject(e(409, 'already_fulfilled', 'This payment request was already settled.'), fresh ?? intent);
    }
    if (db.findSignature(signature)) return reject(e(409, 'signature_reused', 'That transaction was already used for a payment.'), fresh);
    if (account.wallet !== fresh.payer) return reject(e(409, 'wallet_changed', 'Your linked wallet changed while the payment was being checked.'), fresh);

    const verdict = verifyPaymentTransaction({
      tx,
      signature,
      payer: fresh.payer,
      treasury: fresh.treasury,
      reference: fresh.reference,
      memo: fresh.memo,
      lamports: fresh.lamports,
      intentCreatedAt: fresh.createdAt,
      intentExpiresAt: fresh.expiresAt,
      now: this.deps.clock(),
    });
    if (!verdict.ok) return reject(e(422, verdict.code, verdict.error), fresh);

    const item = itemById(fresh.itemId);
    if (!item) return reject(e(404, 'unknown_item', 'That item no longer exists.'), fresh);
    const at = this.deps.clock();
    const granted = this.deps.shop.grantItem(account, item);
    if (!granted.ok) {
      // real money-shaped event on a test network: record it so the signature can never be replayed, and flag it
      fresh.status = 'paid_not_granted';
      fresh.signature = signature;
      fresh.fulfilledAt = at;
      fresh.slot = verdict.slot;
      db.putIntent(fresh);
      db.recordSignature({ signature, intentId: fresh.id, accountId: account.id, at, slot: verdict.slot, lamports: verdict.lamportsReceived, outcome: 'paid_not_granted' });
      log.warn('pay verified but item not granted (needs manual refund)', { account: account.id, intent: fresh.id, item: item.id, signature, lamports: verdict.lamportsReceived });
      return e(409, 'paid_not_granted', `Your payment was verified but ${granted.error} It was not refunded automatically in this test build.`);
    }
    fresh.status = 'fulfilled';
    fresh.signature = signature;
    fresh.fulfilledAt = at;
    fresh.slot = verdict.slot;
    db.putIntent(fresh);
    db.recordSignature({ signature, intentId: fresh.id, accountId: account.id, at, slot: verdict.slot, lamports: verdict.lamportsReceived, outcome: 'granted' });
    log.info('pay confirmed', { account: account.id, intent: fresh.id, item: item.id, lamports: verdict.lamportsReceived, slot: verdict.slot, signature });

    this.deps.notify(account.id, { t: 'account', coins: account.coins, inventory: { ...account.inventory }, equipped: { ...account.equipped } });
    this.deps.notify(account.id, { t: 'toast', level: 'info', text: `Payment verified on Solana Devnet: you got ${item.name}. ${DEVNET_LABEL}.` });
    return { ok: true, item: { id: item.id, name: item.name }, signature };
  }

  /** getTransaction, retried briefly while the node does not know the transaction yet. */
  private async fetchTransaction(signature: string) {
    const start = this.deps.clock();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let tx;
      try {
        tx = await this.deps.rpc.getTransaction(signature);
      } catch (err) {
        if (!(err instanceof RpcError) || !err.transient || attempt >= 2) throw err;
        tx = null; // a hiccup: try a couple more times
      }
      if (tx) return tx;
      if (this.deps.clock() - start >= this.deps.config.confirmTimeoutMs) return null;
      await this.sleep(RETRY_DELAY_MS);
      if (this.deps.clock() - start >= this.deps.config.confirmTimeoutMs) return null;
    }
    return null;
  }
}

