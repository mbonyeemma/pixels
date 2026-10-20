import fs from 'node:fs';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bs58 from 'bs58';
import { afterEach, describe, expect, it } from 'vitest';
import { DEVNET_GENESIS_HASH, itemById, type PayIntentView } from '@pixels/shared';
import { loadConfig } from '../src/config';
import { PaymentsConfigError, checkRpcUrl, parsePaymentsConfig } from '../src/solana/config';
import { HttpSolanaRpc } from '../src/solana/rpc';
import { PayConfirmRequestSchema, PayIntentRequestSchema, WalletChallengeRequestSchema, WalletVerifyRequestSchema } from '../src/solana/schemas';
import { RpcError, type ParsedTransaction } from '../src/solana/types';
import { BLOCK_TIME_SKEW_MS, verifyPaymentTransaction, type VerifyInput } from '../src/solana/verify';
import { makeHarness, rmDir, tmpDir } from './helpers';
import { bearer, linkOverHttp, makeWallet, mockPaymentTx, payConfig, post } from './solanaHelpers';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const treasury = makeWallet();
const payer = makeWallet();
const reference = makeWallet().publicKey;

function base(over: Partial<VerifyInput> & { txOver?: Partial<Parameters<typeof mockPaymentTx>[0]> } = {}): VerifyInput {
  const { signature, tx } = mockPaymentTx({ payer, treasury: treasury.publicKey, reference, lamports: 10_000_000, blockTimeMs: NOW, memo: 'pixels:abc', ...over.txOver });
  return {
    tx,
    signature,
    payer: payer.publicKey,
    treasury: treasury.publicKey,
    reference,
    memo: 'pixels:abc',
    lamports: 10_000_000,
    intentCreatedAt: NOW - 1000,
    intentExpiresAt: NOW + 600_000,
    now: NOW + 5000,
    ...over,
  };
}

describe('verifyPaymentTransaction (pure)', () => {
  it('accepts an exact and a larger payment and reports what the treasury received', () => {
    const exact = verifyPaymentTransaction(base());
    expect(exact).toMatchObject({ ok: true, lamportsReceived: 10_000_000 });
    expect(verifyPaymentTransaction(base({ txOver: { lamports: 12_000_000 } }))).toMatchObject({ ok: true, lamportsReceived: 12_000_000 });
  });

  it('accepts a transaction without a memo (the reference is what binds it)', () => {
    expect(verifyPaymentTransaction(base({ txOver: { memo: null } })).ok).toBe(true);
  });

  it('fails closed on a malformed transaction', () => {
    const i = base();
    for (const tx of [null, {}, { transaction: {} }, { ...i.tx, meta: null }] as unknown as ParsedTransaction[]) {
      expect(verifyPaymentTransaction({ ...i, tx }).ok).toBe(false);
    }
    const noBalances = { ...i.tx, meta: { err: null } } as unknown as ParsedTransaction;
    expect(verifyPaymentTransaction({ ...i, tx: noBalances })).toMatchObject({ ok: false, code: 'balance_mismatch' });
  });

  it('rejects missing/invalid slot or block time', () => {
    const i = base();
    expect(verifyPaymentTransaction({ ...i, tx: { ...i.tx, blockTime: null } })).toMatchObject({ code: 'bad_time' });
    expect(verifyPaymentTransaction({ ...i, tx: { ...i.tx, slot: 0 } })).toMatchObject({ code: 'bad_time' });
    expect(verifyPaymentTransaction({ ...i, tx: { ...i.tx, slot: 1.5 } })).toMatchObject({ code: 'bad_time' });
  });

  it('allows a little clock drift but not much', () => {
    expect(verifyPaymentTransaction(base({ txOver: { blockTimeMs: NOW - 1000 - BLOCK_TIME_SKEW_MS + 2000 } })).ok).toBe(true);
    expect(verifyPaymentTransaction(base({ txOver: { blockTimeMs: NOW - 1000 - BLOCK_TIME_SKEW_MS - 5000 } }))).toMatchObject({ code: 'bad_time' });
    expect(verifyPaymentTransaction(base({ txOver: { blockTimeMs: NOW + 3_600_000 }, intentExpiresAt: NOW + 7_200_000 }))).toMatchObject({ code: 'bad_time' }); // future
  });

  it('a signer reference account is not accepted', () => {
    const i = base();
    const keys = i.tx.transaction.message.accountKeys as { pubkey: string; signer: boolean }[];
    keys.find((k) => k.pubkey === reference)!.signer = true;
    expect(verifyPaymentTransaction(i)).toMatchObject({ code: 'missing_reference' });
  });

  it('a transfer of the right size to the treasury from somebody else is wrong_sender', () => {
    const i = base({ txOver: { source: makeWallet().publicKey } });
    expect(verifyPaymentTransaction(i)).toMatchObject({ code: 'wrong_sender' });
  });

  it('ignores non-transfer system instructions and other programs', () => {
    const i = base();
    const ix = i.tx.transaction.message.instructions[0];
    ix.parsed = { type: 'createAccount', info: ix.parsed && (ix.parsed as { info: unknown }).info };
    expect(verifyPaymentTransaction(i)).toMatchObject({ code: 'wrong_recipient' });
    const j = base();
    j.tx.transaction.message.instructions[0].programId = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    expect(verifyPaymentTransaction(j)).toMatchObject({ code: 'wrong_recipient' });
  });

  it('accepts a lamports value delivered as a numeric string, rejects junk', () => {
    const i = base();
    ((i.tx.transaction.message.instructions[0].parsed as { info: { lamports: unknown } }).info).lamports = '10000000';
    expect(verifyPaymentTransaction(i).ok).toBe(true);
    ((i.tx.transaction.message.instructions[0].parsed as { info: { lamports: unknown } }).info).lamports = 'lots';
    expect(verifyPaymentTransaction(i)).toMatchObject({ code: 'wrong_recipient' });
  });
});

describe('payments configuration', () => {
  it('is disabled by default and needs nothing', () => {
    expect(parsePaymentsConfig({}).enabled).toBe(false);
    expect(parsePaymentsConfig({ PAYMENTS_ENABLED: 'false', SOLANA_CLUSTER: 'mainnet-beta' }).enabled).toBe(false);
    expect(loadConfig({}, '/tmp', '/tmp/srv').payments.enabled).toBe(false);
  });

  it('enabled needs a valid treasury public key; defaults to the public devnet RPC', () => {
    const cfg = parsePaymentsConfig({ PAYMENTS_ENABLED: 'true', SOLANA_TREASURY_PUBKEY: treasury.publicKey });
    expect(cfg).toMatchObject({ enabled: true, cluster: 'devnet', rpcUrl: 'https://api.devnet.solana.com', treasury: treasury.publicKey, tokenMint: null });
    expect(() => parsePaymentsConfig({ PAYMENTS_ENABLED: 'true' })).toThrow(PaymentsConfigError);
    expect(() => parsePaymentsConfig({ PAYMENTS_ENABLED: 'true', SOLANA_TREASURY_PUBKEY: 'nope' })).toThrow(/valid Solana public key/);
  });

  it('refuses any cluster other than devnet', () => {
    const env = { PAYMENTS_ENABLED: 'true', SOLANA_TREASURY_PUBKEY: treasury.publicKey };
    for (const c of ['mainnet-beta', 'mainnet', 'testnet', 'localnet']) {
      expect(() => parsePaymentsConfig({ ...env, SOLANA_CLUSTER: c }), c).toThrow(/devnet/i);
    }
    expect(parsePaymentsConfig({ ...env, SOLANA_CLUSTER: 'DEVNET' }).enabled).toBe(true);
  });

  it('refuses mainnet / testnet / non-https RPC URLs (URL guard)', () => {
    for (const u of ['https://api.mainnet-beta.solana.com', 'https://solana-mainnet.g.alchemy.com/v2/x', 'https://api.testnet.solana.com', 'http://api.devnet.solana.com', 'ftp://x', 'not a url']) {
      expect(checkRpcUrl(u), u).not.toBeNull();
    }
    for (const u of ['https://api.devnet.solana.com', 'https://devnet.helius-rpc.com/?api-key=x', 'http://127.0.0.1:8899', 'http://localhost:9000/rpc']) {
      expect(checkRpcUrl(u), u).toBeNull();
    }
    expect(() => parsePaymentsConfig({ PAYMENTS_ENABLED: '1', SOLANA_TREASURY_PUBKEY: treasury.publicKey, SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com' })).toThrow(/mainnet/i);
  });

  it('refuses secret keys and seed phrases in the environment', () => {
    const env = { PAYMENTS_ENABLED: 'true' };
    // a base58 keypair and a solana-keygen style JSON byte array both look like secrets
    expect(() => parsePaymentsConfig({ ...env, SOLANA_TREASURY_PUBKEY: bs58.encode(treasury.secretKey) })).toThrow(/SECRET key/);
    expect(() => parsePaymentsConfig({ ...env, SOLANA_TREASURY_PUBKEY: JSON.stringify([...treasury.secretKey]) })).toThrow(/SECRET key/);
    expect(() => parsePaymentsConfig({ ...env, SOLANA_TREASURY_PUBKEY: treasury.publicKey, SOLANA_PRIVATE_KEY: 'abc' })).toThrow(/never holds private keys/);
    expect(() => parsePaymentsConfig({ ...env, SOLANA_TREASURY_PUBKEY: treasury.publicKey, TREASURY_SEED_PHRASE: 'word word' })).toThrow(/never holds private keys/);
  });

  it('reports a token mint but never prices in tokens; confirmation timeout is clamped', () => {
    const cfg = parsePaymentsConfig({ PAYMENTS_ENABLED: 'yes', SOLANA_TREASURY_PUBKEY: treasury.publicKey, SOLANA_TOKEN_MINT: makeWallet().publicKey, SOLANA_CONFIRMATION_TIMEOUT_MS: '9999999' });
    expect(cfg.tokenMint).toBeTruthy();
    expect(cfg.confirmTimeoutMs).toBe(120_000);
  });
});

describe('HttpSolanaRpc (stubbed fetch)', () => {
  const stub = (handler: (body: { method: string; params: unknown[] }) => unknown, status = 200) =>
    (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string; params: unknown[]; id: number };
      const out = handler(body);
      return new Response(typeof out === 'string' ? out : JSON.stringify({ jsonrpc: '2.0', id: body.id, ...(out as object) }), { status });
    }) as unknown as typeof fetch;

  it('asks getTransaction for confirmed, jsonParsed, version 0', async () => {
    let seen: { method: string; params: unknown[] } | null = null;
    const rpc = new HttpSolanaRpc('https://rpc.example/?api-key=SECRET', {
      fetchImpl: stub((b) => {
        seen = b;
        return { result: null };
      }),
    });
    expect(await rpc.getTransaction('sig')).toBeNull();
    expect(seen).toMatchObject({ method: 'getTransaction', params: ['sig', { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] });
    expect(rpc.host).toBe('rpc.example'); // the api key never leaves this class
  });

  it('returns the genesis hash and the transaction', async () => {
    const t = mockPaymentTx({ payer, treasury: treasury.publicKey, reference, lamports: 1, blockTimeMs: NOW });
    const rpc = new HttpSolanaRpc('https://rpc.example', { fetchImpl: stub((b) => ({ result: b.method === 'getGenesisHash' ? DEVNET_GENESIS_HASH : t.tx })) });
    expect(await rpc.getGenesisHash()).toBe(DEVNET_GENESIS_HASH);
    expect((await rpc.getTransaction(t.signature))!.transaction.signatures[0]).toBe(t.signature);
  });

  it('turns node errors, HTTP failures, bad JSON and oversized answers into RpcError', async () => {
    const mk = (f: typeof fetch, maxBytes?: number) => new HttpSolanaRpc('https://rpc.example', { fetchImpl: f, maxBytes });
    await expect(mk(stub(() => ({ error: { code: -32005, message: 'busy' } }))).getTransaction('s')).rejects.toBeInstanceOf(RpcError);
    await expect(mk(stub(() => '{}', 429)).getTransaction('s')).rejects.toMatchObject({ transient: true });
    await expect(mk(stub(() => 'not json')).getTransaction('s')).rejects.toBeInstanceOf(RpcError);
    await expect(mk(stub(() => ({ result: 5 }))).getGenesisHash()).rejects.toBeInstanceOf(RpcError);
    await expect(mk(stub(() => ({ result: { a: 'x'.repeat(500) } })), 100).getTransaction('s')).rejects.toMatchObject({ transient: false });
    await expect(mk((async () => { throw new TypeError('network'); }) as unknown as typeof fetch).getTransaction('s')).rejects.toBeInstanceOf(RpcError);
  });

  it('times out a hanging node', async () => {
    const hang = ((_u: unknown, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as unknown as typeof fetch;
    await expect(new HttpSolanaRpc('https://rpc.example', { fetchImpl: hang, timeoutMs: 30 }).getTransaction('s')).rejects.toThrow(/timed out/);
  });
});

describe('end to end against a real local JSON-RPC server (the production HttpSolanaRpc code path)', () => {
  let rpcServer: Server | undefined;
  afterEach(() => new Promise<void>((r) => (rpcServer ? rpcServer.close(() => r()) : r())));

  it('challenge -> verify -> intent -> pay -> confirm', async () => {
    const txs = new Map<string, ParsedTransaction>();
    const methods: string[] = [];
    rpcServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const q = JSON.parse(raw) as { id: number; method: string; params: unknown[] };
        methods.push(q.method);
        const result = q.method === 'getGenesisHash' ? DEVNET_GENESIS_HASH : q.method === 'getTransaction' ? (txs.get(q.params[0] as string) ?? null) : null;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }));
      });
    });
    await new Promise<void>((r) => rpcServer!.listen(0, '127.0.0.1', r));
    const rpcUrl = `http://127.0.0.1:${(rpcServer.address() as AddressInfo).port}`;

    const h = makeHarness({ payments: { config: payConfig(treasury.publicKey, { rpcUrl }), rpc: new HttpSolanaRpc(rpcUrl) } });
    const port = await h.srv.start(0, '127.0.0.1');
    const url = `http://127.0.0.1:${port}`;
    try {
      const { token, account } = h.signup('alice', 'a@example.com');
      const wallet = makeWallet();
      expect((await linkOverHttp(url, token, wallet)).status).toBe(200);
      const it = (await (await post(url + '/api/pay/intent', { itemId: 'sunset_hoodie' }, bearer(token))).json()) as PayIntentView;
      expect(it.lamports).toBe(itemById('sunset_hoodie')!.priceLamports);
      const t = mockPaymentTx({ payer: wallet, treasury: treasury.publicKey, reference: it.reference, lamports: it.lamports, blockTimeMs: h.clock(), memo: it.memo });
      txs.set(t.signature, t.tx);
      const done = await post(url + '/api/pay/confirm', { intentId: it.intentId, signature: t.signature }, bearer(token));
      expect(done.status).toBe(200);
      expect(account.inventory.sunset_hoodie).toBe(1);
      expect(methods).toEqual(['getGenesisHash', 'getTransaction']);
    } finally {
      await h.close();
    }
  });
});

describe('db: payments ledger persistence and wallet index', () => {
  it('rejects the same wallet on two accounts when loading, and prunes expired pending intents only', async () => {
    const h = makeHarness();
    const a = h.signup('alice', 'a@example.com').account;
    const b = h.signup('bob', 'b@example.com').account;
    const w = makeWallet().publicKey;
    expect(h.srv.db.setWallet(a, w)).toBe(true);
    expect(h.srv.db.setWallet(b, w)).toBe(false);
    expect(b.wallet).toBeNull();
    h.srv.db.putIntent({ id: 'i1', accountId: a.id, itemId: 'genesis_pixel', lamports: 1, payer: w, treasury: 't', reference: 'r', memo: 'm', createdAt: 0, expiresAt: 1, status: 'pending' });
    h.srv.db.putIntent({ id: 'i2', accountId: a.id, itemId: 'genesis_pixel', lamports: 1, payer: w, treasury: 't', reference: 'r2', memo: 'm', createdAt: 0, expiresAt: 1, status: 'fulfilled', signature: 's' });
    h.srv.db.pruneIntents(h.clock());
    expect(h.srv.db.getIntent('i1')).toBeUndefined();
    expect(h.srv.db.getIntent('i2')).toBeDefined();
    await h.close();
  });
  it('a damaged payments section never costs players their accounts (and the file is backed up)', async () => {
    const dir = tmpDir();
    const h = makeHarness({ dataDir: dir });
    const a = h.signup('alice', 'a@example.com').account;
    await h.srv.db.flush();
    const file = path.join(dir, 'db.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { payments: unknown };
    await h.close();
    try {
      for (const damaged of [{ intents: ['junk', 5], signatures: [{ nope: true }] }, 'garbage']) {
        data.payments = damaged;
        fs.writeFileSync(file, JSON.stringify(data));
        const h2 = makeHarness({ dataDir: dir });
        try {
          expect(h2.srv.db.findByEmail('a@example.com')?.id).toBe(a.id);
          expect(h2.srv.db.signatureCount).toBe(0);
          expect(fs.readdirSync(dir).some((f) => f.includes('invalid-payments'))).toBe(true);
        } finally {
          await h2.close();
        }
      }
    } finally {
      rmDir(dir);
    }
  });
});

describe('request schemas', () => {
  it('accept well-formed bodies and reject junk', () => {
    const pk = '11111111111111111111111111111112';
    expect(WalletChallengeRequestSchema.safeParse({ publicKey: pk }).success).toBe(true);
    expect(WalletChallengeRequestSchema.safeParse({ publicKey: 'short' }).success).toBe(false);
    expect(WalletChallengeRequestSchema.safeParse({}).success).toBe(false);
    expect(WalletVerifyRequestSchema.safeParse({ publicKey: pk, signature: 'x'.repeat(88) }).success).toBe(true);
    expect(WalletVerifyRequestSchema.safeParse({ publicKey: pk, signature: 'x'.repeat(10) }).success).toBe(false);
    expect(PayIntentRequestSchema.safeParse({ itemId: 'genesis_pixel' }).success).toBe(true);
    expect(PayIntentRequestSchema.safeParse({ itemId: '' }).success).toBe(false);
    expect(PayConfirmRequestSchema.safeParse({ intentId: 'a'.repeat(16), signature: 'x'.repeat(88) }).success).toBe(true);
    expect(PayConfirmRequestSchema.safeParse({ intentId: 'a', signature: 'x'.repeat(88) }).success).toBe(false);
  });
});
