import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { afterEach, describe, expect, it } from 'vitest';
import { DEVNET_LABEL, WALLET_CHALLENGE_TTL_MS } from '@pixels/shared';
import { makeHarness } from './helpers';
import { bearer, bootPayments, del, linkOverHttp, makeWallet, post, type PayHarness } from './solanaHelpers';

let p: PayHarness | undefined;
afterEach(async () => {
  await p?.close();
  p = undefined;
});

async function challenge(base: string, publicKey: string) {
  const res = await post(base + '/api/wallet/challenge', { publicKey });
  return { res, body: (await res.json()) as { nonce: string; message: string; expiresAt: number; error?: string; code?: string } };
}
const meWallet = async (base: string, token: string) =>
  ((await (await fetch(base + '/api/me', { headers: bearer(token) })).json()) as { wallet: string | null }).wallet;

describe('GET /api/config', () => {
  it('reports enabled + treasury (public key only) + devnet when payments are on', async () => {
    p = await bootPayments();
    const res = await fetch(p.base + '/api/config');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, cluster: 'devnet', treasury: p.treasury.publicKey, tokenMint: null });
  });

  it('reports enabled:false and no treasury when payments are off (default)', async () => {
    const h = makeHarness();
    const port = await h.srv.start(0, '127.0.0.1');
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/config`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled: false, cluster: 'devnet' });
    } finally {
      await h.close();
    }
  });
});

describe('feature flag off: every wallet and payment endpoint is disabled', () => {
  it('answers 404 payments_disabled and never creates state', async () => {
    const h = makeHarness();
    const port = await h.srv.start(0, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    try {
      const { token } = h.signup('alice', 'a@example.com');
      const w = makeWallet();
      const calls = [
        post(base + '/api/wallet/challenge', { publicKey: w.publicKey }),
        post(base + '/api/wallet/verify', { publicKey: w.publicKey, signature: 'x'.repeat(88) }),
        del(base + '/api/wallet', bearer(token)),
        post(base + '/api/pay/intent', { itemId: 'genesis_pixel' }, bearer(token)),
        post(base + '/api/pay/confirm', { intentId: 'a'.repeat(16), signature: 'x'.repeat(88) }, bearer(token)),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.status).toBe(404);
        expect(((await res.json()) as { code: string }).code).toBe('payments_disabled');
      }
      expect(h.srv.payments).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('an explicitly disabled config behaves the same as no config', async () => {
    const h = makeHarness({ payments: { config: { enabled: false, cluster: 'devnet', rpcUrl: 'http://x', treasury: null, tokenMint: null, confirmTimeoutMs: 1000 }, rpc: undefined as never } });
    expect(h.srv.payments).toBeNull();
    await h.close();
  });
});

describe('POST /api/wallet/challenge', () => {
  it('issues a human-readable, devnet-labelled message with a 5 minute expiry', async () => {
    p = await bootPayments();
    const w = makeWallet();
    const { res, body } = await challenge(p.base, w.publicKey);
    expect(res.status).toBe(200);
    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(body.expiresAt).toBe(p.h.clock() + WALLET_CHALLENGE_TTL_MS);
    expect(body.message).toContain(w.publicKey);
    expect(body.message).toContain(body.nonce);
    expect(body.message).toContain('Devnet');
    expect(body.message).toContain(DEVNET_LABEL);
    expect(body.message).toMatch(/cannot move any funds/);
    expect(body.message).toContain(new Date(body.expiresAt).toISOString());
  });

  it('every challenge is different', async () => {
    p = await bootPayments();
    const w = makeWallet();
    const a = await challenge(p.base, w.publicKey);
    const b = await challenge(p.base, w.publicKey);
    expect(a.body.nonce).not.toBe(b.body.nonce);
  });

  it('rejects malformed public keys', async () => {
    p = await bootPayments();
    for (const publicKey of ['', 'short', 'not base58 !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!', bs58.encode(new Uint8Array(31)), bs58.encode(new Uint8Array(64).fill(7))]) {
      const { res, body } = await challenge(p.base, publicKey);
      expect(res.status, publicKey).toBe(400);
      expect(body.error).toContain('DEVNET TEST');
    }
    expect((await post(p.base + '/api/wallet/challenge', {})).status).toBe(400);
  });

  it('is rate limited per IP', async () => {
    p = await bootPayments();
    const w = makeWallet();
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await post(p.base + '/api/wallet/challenge', { publicKey: w.publicKey })).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(10)).toContain(429);
    p.h.clock.advance(60_000);
    expect((await post(p.base + '/api/wallet/challenge', { publicKey: w.publicKey })).status).toBe(200);
  });
});

describe('POST /api/wallet/verify: signature checks', () => {
  it('links the wallet to the signed-in account and persists it', async () => {
    p = await bootPayments();
    const { token, account } = p.h.signup('alice', 'a@example.com');
    const w = makeWallet();
    const res = await linkOverHttp(p.base, token, w);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; account: { wallet: string }; notice: string };
    expect(body.mode).toBe('link');
    expect(body.account.wallet).toBe(w.publicKey);
    expect(body.notice).toBe(DEVNET_LABEL);
    expect(account.wallet).toBe(w.publicKey);
    expect(p.h.srv.db.findByWallet(w.publicKey)?.id).toBe(account.id);
    expect(await meWallet(p.base, token)).toBe(w.publicKey);
  });

  it('rejects a signature from the wrong key and keeps the challenge usable for the right key', async () => {
    p = await bootPayments();
    const { token } = p.h.signup('alice', 'a@example.com');
    const w = makeWallet();
    const attacker = makeWallet();
    const ch = (await challenge(p.base, w.publicKey)).body;
    const bad = await post(p.base + '/api/wallet/verify', { publicKey: w.publicKey, signature: attacker.sign(ch.message), nonce: ch.nonce }, bearer(token));
    expect(bad.status).toBe(401);
    const badBody = (await bad.json()) as { code: string; error: string };
    expect(badBody.code).toBe('bad_signature');
    expect(badBody.error).toContain('DEVNET TEST');
    expect(p.h.srv.db.findByWallet(w.publicKey)).toBeUndefined();
    // a stranger's wrong signature did not burn the real owner's challenge
    const ok = await post(p.base + '/api/wallet/verify', { publicKey: w.publicKey, signature: w.sign(ch.message), nonce: ch.nonce }, bearer(token));
    expect(ok.status).toBe(200);
  });

  it('rejects a signature over a tampered message', async () => {
    p = await bootPayments();
    const { token } = p.h.signup('alice', 'a@example.com');
    const w = makeWallet();
    const ch = (await challenge(p.base, w.publicKey)).body;
    const tampered = ch.message.replace('Devnet', 'Mainnet');
    const res = await post(p.base + '/api/wallet/verify', { publicKey: w.publicKey, signature: w.sign(tampered), nonce: ch.nonce }, bearer(token));
    expect(res.status).toBe(401);
    expect(p.h.srv.db.findByWallet(w.publicKey)).toBeUndefined();
  });

  it('a challenge can be used once only (replayed nonce)', async () => {
    p = await bootPayments();
    const a = p.h.signup('alice', 'a@example.com');
    const b = p.h.signup('bob', 'b@example.com');
    const w = makeWallet();
    const ch = (await challenge(p.base, w.publicKey)).body;
    const body = { publicKey: w.publicKey, signature: w.sign(ch.message), nonce: ch.nonce };
    expect((await post(p.base + '/api/wallet/verify', body, bearer(a.token))).status).toBe(200);
    // unlink, then replay the very same signed challenge for another account
    expect((await del(p.base + '/api/wallet', bearer(a.token))).status).toBe(200);
    const replay = await post(p.base + '/api/wallet/verify', body, bearer(b.token));
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { code: string }).code).toBe('no_challenge');
    expect(p.h.srv.db.findByWallet(w.publicKey)).toBeUndefined();
  });

  it('rejects an expired challenge', async () => {
    p = await bootPayments();
    const { token } = p.h.signup('alice', 'a@example.com');
    const w = makeWallet();
    const ch = (await challenge(p.base, w.publicKey)).body;
    p.h.clock.advance(WALLET_CHALLENGE_TTL_MS + 1);
    const res = await post(p.base + '/api/wallet/verify', { publicKey: w.publicKey, signature: w.sign(ch.message), nonce: ch.nonce }, bearer(token));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('no_challenge');
  });

  it('a challenge is bound to its public key', async () => {
    p = await bootPayments();
    const { token } = p.h.signup('alice', 'a@example.com');
    const w1 = makeWallet();
    const w2 = makeWallet();
    const ch1 = (await challenge(p.base, w1.publicKey)).body;
    // w2 signs w1's message and claims to be w2
    const res = await post(p.base + '/api/wallet/verify', { publicKey: w2.publicKey, signature: w2.sign(ch1.message), nonce: ch1.nonce }, bearer(token));
    expect(res.status).toBe(401);
    expect(p.h.srv.db.findByWallet(w2.publicKey)).toBeUndefined();
  });

  it('works without sending the nonce (the server tries the pending challenges of that key)', async () => {
    p = await bootPayments();
    const { token } = p.h.signup('alice', 'a@example.com');
    const w = makeWallet();
    await challenge(p.base, w.publicKey);
    const ch = (await challenge(p.base, w.publicKey)).body;
    const res = await post(p.base + '/api/wallet/verify', { publicKey: w.publicKey, signature: w.sign(ch.message) }, bearer(token));
    expect(res.status).toBe(200);
  });

  it('rejects malformed signatures and unknown keys', async () => {
    p = await bootPayments();
    const w = makeWallet();
    await challenge(p.base, w.publicKey);
    const short = await post(p.base + '/api/wallet/verify', { publicKey: w.publicKey, signature: bs58.encode(new Uint8Array(32)) });
    expect(short.status).toBe(400);
    const junk = await post(p.base + '/api/wallet/verify', { publicKey: w.publicKey, signature: '0'.repeat(88) });
    expect(junk.status).toBe(400);
    const noChallenge = await post(p.base + '/api/wallet/verify', { publicKey: makeWallet().publicKey, signature: bs58.encode(new Uint8Array(64).fill(1)) });
    expect(noChallenge.status).toBe(401);
    expect(((await noChallenge.json()) as { code: string }).code).toBe('no_challenge');
  });

  it('an invalid bearer token is 401, never a silent sign-in', async () => {
    p = await bootPayments();
    const w = makeWallet();
    const res = await linkOverHttp(p.base, '0'.repeat(64), w);
    expect(res.status).toBe(401);
  });
});

describe('link, unlink and sign in', () => {
  it('re-linking the same wallet is idempotent', async () => {
    p = await bootPayments();
    const { token } = p.h.signup('alice', 'a@example.com');
    const w = makeWallet();
    expect((await linkOverHttp(p.base, token, w)).status).toBe(200);
    expect((await linkOverHttp(p.base, token, w)).status).toBe(200);
    expect(await meWallet(p.base, token)).toBe(w.publicKey);
  });

  it('refuses a wallet that is already linked to another account', async () => {
    p = await bootPayments();
    const a = p.h.signup('alice', 'a@example.com');
    const b = p.h.signup('bob', 'b@example.com');
    const w = makeWallet();
    expect((await linkOverHttp(p.base, a.token, w)).status).toBe(200);
    const res = await linkOverHttp(p.base, b.token, w);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('wallet_taken');
    expect(body.error).toContain('another Pixels account');
    expect(b.account.wallet).toBeNull();
    expect(p.h.srv.db.findByWallet(w.publicKey)?.id).toBe(a.account.id);
  });

  it('allows one wallet per account until it is unlinked', async () => {
    p = await bootPayments();
    const a = p.h.signup('alice', 'a@example.com');
    const w1 = makeWallet();
    const w2 = makeWallet();
    expect((await linkOverHttp(p.base, a.token, w1)).status).toBe(200);
    const second = await linkOverHttp(p.base, a.token, w2);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe('account_has_wallet');
    expect(a.account.wallet).toBe(w1.publicKey);

    const un = await del(p.base + '/api/wallet', bearer(a.token));
    expect(un.status).toBe(200);
    expect(((await un.json()) as { account: { wallet: string | null } }).account.wallet).toBeNull();
    expect(p.h.srv.db.findByWallet(w1.publicKey)).toBeUndefined();
    expect((await linkOverHttp(p.base, a.token, w2)).status).toBe(200);
    expect(a.account.wallet).toBe(w2.publicKey);
    // the old wallet is free for somebody else now
    const b = p.h.signup('bob', 'b@example.com');
    expect((await linkOverHttp(p.base, b.token, w1)).status).toBe(200);
  });

  it('unlinking needs a valid bearer token and is idempotent', async () => {
    p = await bootPayments();
    const a = p.h.signup('alice', 'a@example.com');
    expect((await del(p.base + '/api/wallet')).status).toBe(401);
    expect((await del(p.base + '/api/wallet', bearer(a.token))).status).toBe(200);
    expect((await del(p.base + '/api/wallet', bearer(a.token))).status).toBe(200);
  });

  it('signs in with a linked wallet (no bearer) and returns a working fresh token', async () => {
    p = await bootPayments();
    const a = p.h.signup('alice', 'a@example.com');
    const w = makeWallet();
    expect((await linkOverHttp(p.base, a.token, w)).status).toBe(200);
    const res = await linkOverHttp(p.base, null, w);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; token: string; account: { id: string; wallet: string } };
    expect(body.mode).toBe('signin');
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.token).not.toBe(a.token);
    expect(body.account.id).toBe(a.account.id);
    const me = await fetch(p.base + '/api/me', { headers: bearer(body.token) });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { id: string }).id).toBe(a.account.id);
  });

  it('an unknown wallet without a bearer gets a helpful 404 (create an account first)', async () => {
    p = await bootPayments();
    const w = makeWallet();
    const res = await linkOverHttp(p.base, null, w);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('wallet_unknown');
    expect(body.error).toMatch(/create an account/i);
    expect(body.error).toMatch(/username and email/i);
    expect(p.h.srv.db.accountCount).toBe(0);
  });

  it('survives a server restart (the link is persisted)', async () => {
    p = await bootPayments();
    const a = p.h.signup('alice', 'a@example.com');
    const w = makeWallet();
    expect((await linkOverHttp(p.base, a.token, w)).status).toBe(200);
    await p.h.srv.db.flush();
    const dir = p.h.dir;
    // reopen the same data dir in a second server
    const p2 = await bootPayments({ dataDir: dir });
    try {
      expect(p2.h.srv.db.findByWallet(w.publicKey)?.id).toBe(a.account.id);
      const res = await linkOverHttp(p2.base, null, w);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { mode: string }).mode).toBe('signin');
    } finally {
      await p2.close();
    }
  });

  it('tweetnacl really verifies what the browser wallet signs (sanity check of the test helper)', () => {
    const w = makeWallet();
    const msg = new TextEncoder().encode('hello');
    const sig = bs58.decode(w.sign('hello'));
    expect(nacl.sign.detached.verify(msg, sig, bs58.decode(w.publicKey))).toBe(true);
  });
});

describe('cluster guard blocks the wallet endpoints too', () => {
  it('a non-devnet genesis hash switches everything off', async () => {
    p = await bootPayments();
    p.rpc.genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'; // mainnet-beta
    expect(await p.h.srv.payments!.ensureDevnet()).toBe('blocked');
    const w = makeWallet();
    const res = await post(p.base + '/api/wallet/challenge', { publicKey: w.publicKey });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('cluster_guard');
    const cfg = (await (await fetch(p.base + '/api/config')).json()) as { enabled: boolean };
    expect(cfg.enabled).toBe(false);
  });
});
