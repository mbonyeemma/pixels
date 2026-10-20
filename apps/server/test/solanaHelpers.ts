import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { DEVNET_GENESIS_HASH } from '@pixels/shared';
import { RpcError, type ParsedTransaction, type PaymentsConfig, type SolanaRpc } from '../src/solana/types';
import { makeHarness, type Harness } from './helpers';
import type { ServerOptions } from '../src/server';

/** A real ed25519 wallet generated inside the test (never anything but test data). */
export interface TestWallet {
  publicKey: string;
  secretKey: Uint8Array;
  /** sign a message the way a wallet's signMessage does; returns the base58 signature */
  sign(message: string): string;
}

export function makeWallet(): TestWallet {
  const kp = nacl.sign.keyPair();
  return {
    publicKey: bs58.encode(kp.publicKey),
    secretKey: kp.secretKey,
    sign: (message) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey)),
  };
}

/** A programmable stand-in for a Solana Devnet node. */
export class MockSolanaRpc implements SolanaRpc {
  genesis = DEVNET_GENESIS_HASH;
  txs = new Map<string, ParsedTransaction>();
  genesisCalls = 0;
  txCalls = 0;
  /** throw this on the next N getTransaction calls */
  failTxCalls = 0;
  failGenesis = false;
  /** reveal a stored transaction only after this many getTransaction calls (simulates propagation delay) */
  visibleAfterCalls = 0;

  async getGenesisHash(): Promise<string> {
    this.genesisCalls++;
    if (this.failGenesis) throw new RpcError('mock: node down');
    return this.genesis;
  }

  async getTransaction(signature: string): Promise<ParsedTransaction | null> {
    this.txCalls++;
    if (this.failTxCalls > 0) {
      this.failTxCalls--;
      throw new RpcError('mock: node error');
    }
    if (this.txCalls <= this.visibleAfterCalls) return null;
    const tx = this.txs.get(signature);
    return tx ? (JSON.parse(JSON.stringify(tx)) as ParsedTransaction) : null;
  }

  add(signature: string, tx: ParsedTransaction): void {
    this.txs.set(signature, tx);
  }
}

const SYSTEM = '11111111111111111111111111111111';
const MEMO_V2 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export interface MockTxOptions {
  payer: TestWallet;
  treasury: string;
  /** reference account key(s) to include as read-only non-signers; null/[] = none */
  reference?: string | string[] | null;
  lamports: number;
  blockTimeMs: number;
  /** where the transfer really goes (defaults to the treasury) */
  destination?: string;
  /** pretend someone else sent the transfer (source != the signer) */
  source?: string;
  err?: unknown;
  memo?: string | null;
  slot?: number;
  /** override the recorded treasury balance change (defaults to +lamports) */
  treasuryDelta?: number;
}

/** Build a jsonParsed-shaped getTransaction result for a SystemProgram.transfer(+reference)(+memo) transaction. */
export function mockPaymentTx(o: MockTxOptions): { signature: string; tx: ParsedTransaction } {
  const refs = o.reference == null ? [] : Array.isArray(o.reference) ? o.reference : [o.reference];
  const destination = o.destination ?? o.treasury;
  const source = o.source ?? o.payer.publicKey;
  const keys = [
    { pubkey: o.payer.publicKey, signer: true, writable: true, source: 'transaction' },
    ...(destination === o.payer.publicKey ? [] : [{ pubkey: destination, signer: false, writable: true, source: 'transaction' }]),
    ...refs.map((r) => ({ pubkey: r, signer: false, writable: false, source: 'transaction' })),
    { pubkey: SYSTEM, signer: false, writable: false, source: 'transaction' },
    ...(o.memo === null ? [] : [{ pubkey: MEMO_V2, signer: false, writable: false, source: 'transaction' }]),
  ];
  const instructions: ParsedTransaction['transaction']['message']['instructions'] = [
    { program: 'system', programId: SYSTEM, parsed: { type: 'transfer', info: { source, destination, lamports: o.lamports } } },
  ];
  if (o.memo !== null) instructions.push({ program: 'spl-memo', programId: MEMO_V2, parsed: o.memo ?? 'pixels:unknown' });
  const pre = keys.map(() => 2_000_000_000);
  const post = keys.map((k, i) => {
    if (i === 0) return pre[i] - o.lamports - 5000;
    if (k.pubkey === destination) return pre[i] + (o.treasuryDelta ?? o.lamports);
    return pre[i];
  });
  // a wallet signs the transaction message; here a fresh signature over random bytes plays that role
  const signature = bs58.encode(nacl.sign.detached(nacl.randomBytes(120), o.payer.secretKey));
  const tx: ParsedTransaction = {
    slot: o.slot ?? 300_000_000,
    blockTime: Math.floor(o.blockTimeMs / 1000),
    version: 'legacy',
    meta: { err: o.err ?? null, preBalances: pre, postBalances: post },
    transaction: { signatures: [signature], message: { accountKeys: keys, instructions } },
  };
  return { signature, tx };
}

export function payConfig(treasury: string, over: Partial<PaymentsConfig> = {}): PaymentsConfig {
  return { enabled: true, cluster: 'devnet', rpcUrl: 'http://127.0.0.1:1', treasury, tokenMint: null, confirmTimeoutMs: 6000, ...over };
}

export interface PayHarness {
  h: Harness;
  rpc: MockSolanaRpc;
  treasury: TestWallet;
  base: string;
  /** advance the test clock instead of really sleeping */
  slept: number[];
  close(): Promise<void>;
}

/** A full server (HTTP + game) with payments enabled and a mock node. Listens on a random loopback port. */
export async function bootPayments(opts: Partial<ServerOptions> = {}, cfg: Partial<PaymentsConfig> = {}): Promise<PayHarness> {
  const rpc = new MockSolanaRpc();
  const treasury = makeWallet();
  const slept: number[] = [];
  let h!: Harness;
  const sleep = async (ms: number) => {
    slept.push(ms);
    h.clock.advance(ms);
  };
  h = makeHarness({ payments: { config: payConfig(treasury.publicKey, cfg), rpc, sleep }, ...opts });
  const port = await h.srv.start(0, '127.0.0.1');
  return { h, rpc, treasury, base: `http://127.0.0.1:${port}`, slept, close: () => h.close() };
}

export const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
export const del = (url: string, headers: Record<string, string> = {}) => fetch(url, { method: 'DELETE', headers });
export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Run the whole challenge -> sign -> verify dance over HTTP. */
export async function linkOverHttp(base: string, token: string | null, wallet: TestWallet): Promise<Response> {
  const ch = (await (await post(base + '/api/wallet/challenge', { publicKey: wallet.publicKey })).json()) as { nonce: string; message: string };
  return post(base + '/api/wallet/verify', { publicKey: wallet.publicKey, signature: wallet.sign(ch.message), nonce: ch.nonce }, token ? bearer(token) : {});
}
