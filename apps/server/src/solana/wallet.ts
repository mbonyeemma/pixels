import nacl from 'tweetnacl';
import { DEVNET_LABEL, WALLET_CHALLENGE_TTL_MS, type WalletChallengeView } from '@pixels/shared';
import type { Accounts } from '../accounts';
import type { AccountRecord, Database } from '../db';
import type { Logger } from '../log';
import { randomHex, type Clock } from '../util';
import { decodeBase58, decodePublicKey } from './base58';

/** A pending sign-in/link challenge. Bound to one public key, single use, short-lived. */
interface Challenge {
  nonce: string;
  publicKey: string;
  message: string;
  expiresAt: number;
}

export type WalletError = { ok: false; status: number; code: string; error: string };
export type ChallengeResult = { ok: true; view: WalletChallengeView } | WalletError;
export type VerifyOutcome =
  | { ok: true; mode: 'link'; account: AccountRecord }
  | { ok: true; mode: 'signin'; account: AccountRecord; token: string }
  | WalletError;

const MAX_CHALLENGES_PER_KEY = 5;
const MAX_CHALLENGES_TOTAL = 20_000;

const err = (status: number, code: string, error: string): WalletError => ({ ok: false, status, code, error });

/** The exact, human-readable text the wallet signs. Pure so tests (and the web client) can rely on its shape. */
export function buildChallengeMessage(publicKey: string, nonce: string, issuedAt: number, expiresAt: number): string {
  return [
    'Pixels wants you to link or sign in with your Solana wallet.',
    '',
    `${DEVNET_LABEL}. Signing this message is free: it sends no transaction and cannot move any funds or tokens.`,
    '',
    `Wallet: ${publicKey}`,
    `Nonce: ${nonce}`,
    'Network: Solana Devnet (test network)',
    `Issued: ${new Date(issuedAt).toISOString()}`,
    `Expires: ${new Date(expiresAt).toISOString()}`,
    '',
    'Only sign this if you just asked Pixels to link your wallet or sign you in.',
  ].join('\n');
}

/**
 * Wallet link / sign-in. A wallet proves it controls a public key by signing a server-issued challenge (ed25519,
 * verified with tweetnacl). The server never sees a private key, and a signed message cannot move funds.
 */
export class WalletAuth {
  private readonly challenges = new Map<string, Challenge[]>();
  private total = 0;

  constructor(
    private readonly deps: { db: Database; accounts: Accounts; clock: Clock; log: Logger; ttlMs?: number },
  ) {}

  private get ttl(): number {
    return this.deps.ttlMs ?? WALLET_CHALLENGE_TTL_MS;
  }

  private prune(now: number): void {
    for (const [key, list] of this.challenges) {
      const live = list.filter((c) => c.expiresAt > now);
      if (live.length === 0) this.challenges.delete(key);
      else if (live.length !== list.length) this.challenges.set(key, live);
    }
    this.recount();
  }

  createChallenge(publicKey: string): ChallengeResult {
    if (!decodePublicKey(publicKey)) return err(400, 'bad_public_key', 'That is not a valid Solana public key.');
    const now = this.deps.clock();
    if (this.total >= MAX_CHALLENGES_TOTAL / 2) this.prune(now);
    if (this.total >= MAX_CHALLENGES_TOTAL) return err(503, 'busy', 'Too many pending wallet requests. Please try again in a few minutes.');
    const nonce = randomHex(16);
    const expiresAt = now + this.ttl;
    const challenge: Challenge = { nonce, publicKey, message: buildChallengeMessage(publicKey, nonce, now, expiresAt), expiresAt };
    const list = (this.challenges.get(publicKey) ?? []).filter((c) => c.expiresAt > now);
    list.push(challenge);
    while (list.length > MAX_CHALLENGES_PER_KEY) list.shift();
    this.challenges.set(publicKey, list);
    this.recount();
    return { ok: true, view: { nonce, message: challenge.message, expiresAt } };
  }

  private recount(): void {
    let n = 0;
    for (const l of this.challenges.values()) n += l.length;
    this.total = n;
  }

  /** Pending challenges (tests / diagnostics). */
  get pendingCount(): number {
    this.recount();
    return this.total;
  }

  /**
   * Check the signature over a pending challenge for this key and consume it. A challenge is consumed only by a valid
   * signature (so strangers cannot burn someone else's challenge), and then can never be used again.
   */
  private consume(publicKey: string, signature: Uint8Array, nonce: string | undefined): Challenge | null {
    const pk = decodePublicKey(publicKey)!;
    const now = this.deps.clock();
    const list = (this.challenges.get(publicKey) ?? []).filter((c) => c.expiresAt > now);
    const candidates = nonce ? list.filter((c) => c.nonce === nonce) : [...list].reverse();
    for (const c of candidates) {
      if (nacl.sign.detached.verify(new TextEncoder().encode(c.message), signature, pk)) {
        const rest = list.filter((x) => x !== c);
        if (rest.length) this.challenges.set(publicKey, rest);
        else this.challenges.delete(publicKey);
        this.recount();
        return c;
      }
    }
    if (list.length !== (this.challenges.get(publicKey)?.length ?? 0)) {
      if (list.length) this.challenges.set(publicKey, list);
      else this.challenges.delete(publicKey);
      this.recount();
    }
    return null;
  }

  /**
   * Verify a signature and then LINK the wallet to `account` (when signed in) or SIGN IN (when the wallet is already
   * linked and no account is given).
   */
  verify(publicKey: string, signatureB58: string, nonce: string | undefined, account: AccountRecord | null): VerifyOutcome {
    if (!decodePublicKey(publicKey)) return err(400, 'bad_public_key', 'That is not a valid Solana public key.');
    const sig = decodeBase58(signatureB58);
    if (!sig || sig.length !== nacl.sign.signatureLength) return err(400, 'bad_signature', 'The signature must be a base58-encoded 64-byte ed25519 signature.');

    const hasPending = (this.challenges.get(publicKey) ?? []).some((c) => c.expiresAt > this.deps.clock());
    const used = this.consume(publicKey, sig, nonce);
    if (!used) {
      return hasPending
        ? err(401, 'bad_signature', 'That signature does not match the message for this wallet. Ask for a new challenge and sign the exact text shown.')
        : err(401, 'no_challenge', 'There is no pending challenge for this wallet (it may have expired or been used already). Request a new one.');
    }

    const owner = this.deps.db.findByWallet(publicKey);
    if (account) {
      if (owner && owner.id !== account.id) {
        this.deps.log.warn('wallet link refused: already linked elsewhere', { account: account.id });
        return err(409, 'wallet_taken', 'That wallet is already linked to another Pixels account.');
      }
      if (account.wallet && account.wallet !== publicKey) {
        return err(409, 'account_has_wallet', 'Your account already has a different wallet linked. Unlink it first.');
      }
      if (account.wallet !== publicKey) {
        this.deps.db.setWallet(account, publicKey);
        this.deps.log.info('wallet linked', { account: account.id, wallet: publicKey });
      }
      return { ok: true, mode: 'link', account };
    }

    if (!owner) {
      return err(
        404,
        'wallet_unknown',
        'No Pixels account is linked to this wallet yet. First create an account with a username and email, then link your wallet from the wallet menu.',
      );
    }
    const token = this.deps.accounts.issueToken(owner);
    this.deps.log.info('wallet sign-in', { account: owner.id, wallet: publicKey });
    return { ok: true, mode: 'signin', account: owner, token };
  }

  /** Remove the wallet from an account (idempotent). */
  unlink(account: AccountRecord): boolean {
    const had = !!account.wallet;
    if (had) {
      this.deps.db.setWallet(account, null);
      this.deps.log.info('wallet unlinked', { account: account.id });
    }
    return had;
  }
}
