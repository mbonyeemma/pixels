import bs58 from 'bs58';
import { afterEach, describe, expect, it } from 'vitest';
import { DEVNET_LABEL, PAY_INTENT_TTL_MS, itemById, type PayIntentView } from '@pixels/shared';
import { CONFIRM_GRACE_MS } from '../src/solana/payments';
import type { AccountRecord } from '../src/db';
import { RpcError } from '../src/solana/types';
import { bearer, bootPayments, del, linkOverHttp, makeWallet, mockPaymentTx, post, type MockTxOptions, type PayHarness, type TestWallet } from './solanaHelpers';
import { TestClient, FakeTransport } from './helpers';

let p: PayHarness | undefined;
afterEach(async () => {
  await p?.close();
  p = undefined;
});

const PIXEL = itemById('genesis_pixel')!; // 10_000_000 lamports
const HOODIE = itemById('sunset_hoodie')!; // 5_000_000 lamports

interface Player {
  token: string;
  account: AccountRecord;
  wallet: TestWallet;
  client: TestClient;
}

/** An account with a wallet linked through the real challenge/verify flow, connected to the game. */
async function player(name: string, email: string): Promise<Player> {
  const { h, base } = p!;
  const { token, account } = h.signup(name, email);
  const wallet = makeWallet();
  const res = await linkOverHttp(base, token, wallet);
  expect(res.status).toBe(200);
  const transport = new FakeTransport();
  const session = h.srv.game.connect(account, transport)!;
  const client = new TestClient(h, account, session, transport, token);
  client.clear();
  return { token, account, wallet, client };
}

async function intent(pl: Player, itemId = PIXEL.id) {
  const res = await post(p!.base + '/api/pay/intent', { itemId }, bearer(pl.token));
  return { res, body: (await res.json()) as PayIntentView & { error?: string; code?: string; notice?: string } };
}

/** Put a payment transaction on the mock chain for this intent. */
function pay(pl: Player, it: PayIntentView, over: Partial<MockTxOptions> = {}) {
  const t = mockPaymentTx({
    payer: pl.wallet,
    treasury: p!.treasury.publicKey,
    reference: it.reference,
    lamports: it.lamports,
    blockTimeMs: p!.h.clock(),
    memo: it.memo,
    ...over,
  });
  p!.rpc.add(t.signature, t.tx);
  return t.signature;
}

async function confirm(pl: Player, intentId: string, signature: string) {
  const res = await post(p!.base + '/api/pay/confirm', { intentId, signature }, bearer(pl.token));
  return { res, body: (await res.json()) as { ok: boolean; code?: string; error?: string; item?: { id: string; name: string }; signature?: string; pending?: boolean; notice?: string } };
}

describe('POST /api/pay/intent: rules', () => {
  it('requires a signed-in account', async () => {
    p = await bootPayments();
    expect((await post(p.base + '/api/pay/intent', { itemId: PIXEL.id })).status).toBe(401);
    expect((await post(p.base + '/api/pay/intent', { itemId: PIXEL.id }, bearer('0'.repeat(64)))).status).toBe(401);
  });

  it('requires a linked wallet', async () => {
    p = await bootPayments();
    const { token } = p.h.signup('alice', 'a@example.com');
    const res = await post(p.base + '/api/pay/intent', { itemId: PIXEL.id }, bearer(token));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('wallet_required');
    expect(body.error).toContain(DEVNET_LABEL);
  });

  it('refuses items without a lamport price, unknown items and bad bodies', async () => {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    for (const id of ['coffee', 'round_shades', 'neon_sneakers', 'explorer_badge']) {
      const { res, body } = await intent(a, id);
      expect(res.status, id).toBe(400);
      expect(body.code).toBe('not_payable');
    }
    expect((await intent(a, 'moon_rock')).res.status).toBe(404);
    expect((await post(p.base + '/api/pay/intent', {}, bearer(a.token))).status).toBe(400);
    expect((await post(p.base + '/api/pay/intent', { itemId: '' }, bearer(a.token))).status).toBe(400);
  });

  it('refuses a non-consumable the player already owns', async () => {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    a.account.inventory.genesis_pixel = 1;
    const { res, body } = await intent(a);
    expect(res.status).toBe(409);
    expect(body.code).toBe('already_owned');
  });

  it('creates an intent with the catalogue amount, a fresh reference and a 10 minute deadline', async () => {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    const { res, body } = await intent(a);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      itemId: 'genesis_pixel',
      lamports: PIXEL.priceLamports,
      treasury: p.treasury.publicKey,
      cluster: 'devnet',
      expiresAt: p.h.clock() + PAY_INTENT_TTL_MS,
      notice: DEVNET_LABEL,
    });
    expect(body.intentId).toMatch(/^[0-9a-f]{32}$/);
    expect(body.memo).toBe(`pixels:${body.intentId}`);
    expect(bs58.decode(body.reference)).toHaveLength(32);
    // the reference is not the wallet nor the treasury
    expect([a.wallet.publicKey, p.treasury.publicKey]).not.toContain(body.reference);
    expect(p.h.srv.db.getIntent(body.intentId)).toMatchObject({ accountId: a.account.id, payer: a.wallet.publicKey, status: 'pending', lamports: PIXEL.priceLamports });
  });

  it('never takes the amount from the client', async () => {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    const res = await post(p.base + '/api/pay/intent', { itemId: PIXEL.id, lamports: 1, price: 1, amount: 1 }, bearer(a.token));
    expect(((await res.json()) as PayIntentView).lamports).toBe(PIXEL.priceLamports);
  });

  it('hands the same pending request back on a retry, and a new one for another item or account', async () => {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    const b = await player('bob', 'b@example.com');
    const first = (await intent(a)).body;
    expect((await intent(a)).body.intentId).toBe(first.intentId);
    const other = (await intent(a, HOODIE.id)).body;
    expect(other.intentId).not.toBe(first.intentId);
    expect(other.lamports).toBe(HOODIE.priceLamports);
    const bobs = (await intent(b)).body;
    expect(bobs.intentId).not.toBe(first.intentId);
    expect(bobs.reference).not.toBe(first.reference);
    // after expiry a retry mints a new one
    p.h.clock.advance(PAY_INTENT_TTL_MS + 1000);
    expect((await intent(a)).body.intentId).not.toBe(first.intentId);
  });

  it('is rate limited per account', async () => {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await intent(a, i % 2 ? PIXEL.id : HOODIE.id)).res.status);
    expect(statuses).toContain(429);
  });
});

describe('POST /api/pay/confirm: success', () => {
  it('verifies the transaction, grants the item through the inventory path and pushes an account message', async () => {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    const it = (await intent(a)).body;
    const sig = pay(a, it);
    const coinsBefore = a.account.coins;

    const { res, body } = await confirm(a, it.intentId, sig);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, item: { id: 'genesis_pixel', name: PIXEL.name }, signature: sig, notice: DEVNET_LABEL });
    expect(a.account.inventory.genesis_pixel).toBe(1);
    expect(a.account.coins).toBe(coinsBefore); // paid with SOL, coins untouched
    expect(p.h.srv.db.getIntent(it.intentId)).toMatchObject({ status: 'fulfilled', signature: sig });
    expect(p.h.srv.db.findSignature(sig)).toMatchObject({ intentId: it.intentId, accountId: a.account.id, outcome: 'granted' });

    // pushed to the live connection
    expect(a.client.last('account')).toEqual({ t: 'account', coins: coinsBefore, inventory: { genesis_pixel: 1 }, equipped: {} });
    expect(a.client.last('toast')!.text).toContain(DEVNET_LABEL);
  });

  it('accepts a payment of more than the price', async () => {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    const it = (await intent(a, HOODIE.id)).body;
    const sig = pay(a, it, { lamports: it.lamports + 1234 });
    expect((await confirm(a, it.intentId, sig)).res.status).toBe(200);
    expect(a.account.inventory.sunset_hoodie).toBe(1);
  });

  it('confirming twice returns the same result and never double-grants', async () => {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    const it = (await intent(a)).body;
    const sig = pay(a, it);
    const first = await confirm(a, it.intentId, sig);
    a.client.clear();
    const second = await confirm(a, it.intentId, sig);
    expect(second.res.status).toBe(200);
    expect({ ...second.body, notice: undefined }).toEqual({ ...first.body, notice: undefined });
    expect(a.account.inventory.genesis_pixel).toBe(1);
    expect(a.client.of('account')).toHaveLength(0); // nothing is pushed again
    expect(p.h.srv.db.signatureCount).toBe(1);
  });

  it('two simultaneous confirms of the same payment grant exactly once', async () => {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    const it = (await intent(a)).body;
    const sig = pay(a, it);
    const [r1, r2, r3] = await Promise.all([confirm(a, it.intentId, sig), confirm(a, it.intentId, sig), confirm(a, it.intentId, sig)]);
    expect([r1.res.status, r2.res.status, r3.res.status]).toEqual([200, 200, 200]);
    expect(a.account.inventory.genesis_pixel).toBe(1);
    expect(p.h.srv.db.signatureCount).toBe(1);
  });

  it('works when the transaction is not visible yet at first (retries briefly)', async () => {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    const it = (await intent(a)).body;
    const sig = pay(a, it);
    p.rpc.visibleAfterCalls = 3;
    const { res, body } = await confirm(a, it.intentId, sig);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(p.rpc.txCalls).toBe(4);
    expect(p.slept.length).toBe(3);
  });

  it('retries after a transient RPC error', async () => {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    const it = (await intent(a)).body;
    const sig = pay(a, it);
    p.rpc.failTxCalls = 1;
    expect((await confirm(a, it.intentId, sig)).res.status).toBe(200);
  });

  it('answers 202 pending when the transaction never shows up, and succeeds on a later confirm', async () => {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    const it = (await intent(a)).body;
    const t = mockPaymentTx({ payer: a.wallet, treasury: p.treasury.publicKey, reference: it.reference, lamports: it.lamports, blockTimeMs: p.h.clock(), memo: it.memo });
    const early = await confirm(a, it.intentId, t.signature);
    expect(early.res.status).toBe(202);
    expect(early.body).toMatchObject({ ok: false, pending: true, code: 'pending' });
    expect(early.body.error).toContain(DEVNET_LABEL);
    expect(a.account.inventory.genesis_pixel).toBeUndefined();
    p.rpc.add(t.signature, t.tx);
    expect((await confirm(a, it.intentId, t.signature)).res.status).toBe(200);
    expect(a.account.inventory.genesis_pixel).toBe(1);
  });

  it('answers 503 (and grants nothing) when the node keeps failing', async () => {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    const it = (await intent(a)).body;
    const sig = pay(a, it);
    p.rpc.failTxCalls = 99;
    const { res, body } = await confirm(a, it.intentId, sig);
    expect(res.status).toBe(503);
    expect(body.code).toBe('rpc_unavailable');
    expect(a.account.inventory.genesis_pixel).toBeUndefined();
    expect(p.h.srv.db.getIntent(it.intentId)!.status).toBe('pending');
    // the intent is still usable afterwards
    p.rpc.failTxCalls = 0;
    expect((await confirm(a, it.intentId, sig)).res.status).toBe(200);
  });
});

describe('POST /api/pay/confirm: rejections (nothing is ever granted)', () => {
  async function setup() {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    const it = (await intent(a)).body;
    return { a, it };
  }
  const nothingGranted = (a: Player, intentId: string) => {
    expect(a.account.inventory.genesis_pixel).toBeUndefined();
    expect(p!.h.srv.db.getIntent(intentId)!.status).toBe('pending');
    expect(p!.h.srv.db.signatureCount).toBe(0);
    expect(a.client.of('account')).toHaveLength(0);
  };

  it('wrong recipient', async () => {
    const { a, it } = await setup();
    const sig = pay(a, it, { destination: makeWallet().publicKey });
    const { res, body } = await confirm(a, it.intentId, sig);
    expect(res.status).toBe(422);
    expect(body.code).toBe('wrong_recipient');
    expect(body.error).toContain(DEVNET_LABEL);
    nothingGranted(a, it.intentId);
  });

  it('amount too low (even by one lamport)', async () => {
    const { a, it } = await setup();
    const sig = pay(a, it, { lamports: it.lamports - 1 });
    const { res, body } = await confirm(a, it.intentId, sig);
    expect(res.status).toBe(422);
    expect(body.code).toBe('amount_too_low');
    nothingGranted(a, it.intentId);
  });

  it('treasury balance that did not really increase', async () => {
    const { a, it } = await setup();
    const sig = pay(a, it, { treasuryDelta: 1 });
    expect((await confirm(a, it.intentId, sig)).body.code).toBe('balance_mismatch');
    nothingGranted(a, it.intentId);
  });

  it('wrong sender: paid from a wallet that is not the linked one', async () => {
    const { a, it } = await setup();
    const stranger = makeWallet();
    const sig = pay(a, it, { payer: stranger });
    const { res, body } = await confirm(a, it.intentId, sig);
    expect(res.status).toBe(422);
    expect(body.code).toBe('wrong_sender');
    nothingGranted(a, it.intentId);
  });

  it('wrong sender: linked wallet is only named as the transfer source but did not sign', async () => {
    const { a, it } = await setup();
    const stranger = makeWallet();
    const sig = pay(a, it, { payer: stranger, source: a.wallet.publicKey });
    expect((await confirm(a, it.intentId, sig)).body.code).toBe('wrong_sender');
    nothingGranted(a, it.intentId);
  });

  it('missing reference account', async () => {
    const { a, it } = await setup();
    expect((await confirm(a, it.intentId, pay(a, it, { reference: null }))).body.code).toBe('missing_reference');
    expect((await confirm(a, it.intentId, pay(a, it, { reference: makeWallet().publicKey }))).body.code).toBe('missing_reference');
    nothingGranted(a, it.intentId);
  });

  it('failed transaction (meta.err set)', async () => {
    const { a, it } = await setup();
    const sig = pay(a, it, { err: { InstructionError: [0, 'Custom'] } });
    const { res, body } = await confirm(a, it.intentId, sig);
    expect(res.status).toBe(422);
    expect(body.code).toBe('tx_failed');
    nothingGranted(a, it.intentId);
  });

  it('a memo that names another intent', async () => {
    const { a, it } = await setup();
    const sig = pay(a, it, { memo: 'pixels:someoneelse' });
    expect((await confirm(a, it.intentId, sig)).body.code).toBe('memo_mismatch');
    nothingGranted(a, it.intentId);
  });

  it('a transaction made before the intent existed, or after it expired', async () => {
    const { a, it } = await setup();
    const old = pay(a, it, { blockTimeMs: p!.h.clock() - 10 * 60_000 });
    expect((await confirm(a, it.intentId, old)).body.code).toBe('bad_time');
    const late = pay(a, it, { blockTimeMs: p!.h.clock() + PAY_INTENT_TTL_MS + 10 * 60_000 });
    expect((await confirm(a, it.intentId, late)).body.code).toBe('bad_time');
    nothingGranted(a, it.intentId);
  });

  it('the network returned a different transaction than the signature asked for', async () => {
    const { a, it } = await setup();
    const real = mockPaymentTx({ payer: a.wallet, treasury: p!.treasury.publicKey, reference: it.reference, lamports: it.lamports, blockTimeMs: p!.h.clock(), memo: it.memo });
    const other = mockPaymentTx({ payer: a.wallet, treasury: p!.treasury.publicKey, reference: it.reference, lamports: it.lamports, blockTimeMs: p!.h.clock(), memo: it.memo });
    p!.rpc.add(real.signature, other.tx); // mock node answers with someone else's transaction
    expect((await confirm(a, it.intentId, real.signature)).body.code).toBe('tx_mismatch');
    nothingGranted(a, it.intentId);
  });

  it('an expired intent (beyond the confirmation grace)', async () => {
    const { a, it } = await setup();
    const sig = pay(a, it);
    p!.h.clock.advance(PAY_INTENT_TTL_MS + CONFIRM_GRACE_MS + 1);
    const { res, body } = await confirm(a, it.intentId, sig);
    expect(res.status).toBe(410);
    expect(body.code).toBe('intent_expired');
    nothingGranted(a, it.intentId);
  });

  it('still accepts a transaction made in time that is confirmed shortly after the deadline', async () => {
    const { a, it } = await setup();
    const sig = pay(a, it, { blockTimeMs: it.expiresAt - 30_000 });
    p!.h.clock.advance(PAY_INTENT_TTL_MS + 60_000);
    expect((await confirm(a, it.intentId, sig)).res.status).toBe(200);
  });

  it("another account's intent is a 404 (and the owner can still use it)", async () => {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    const b = await player('bob', 'b@example.com');
    const it = (await intent(a)).body;
    const sig = pay(a, it);
    const { res, body } = await confirm(b, it.intentId, sig);
    expect(res.status).toBe(404);
    expect(body.code).toBe('unknown_intent');
    expect(b.account.inventory.genesis_pixel).toBeUndefined();
    expect(a.account.inventory.genesis_pixel).toBeUndefined();
    expect((await confirm(a, it.intentId, sig)).res.status).toBe(200);
  });

  it("someone else cannot claim a player's payment with their own intent", async () => {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    const b = await player('bob', 'b@example.com');
    const ia = (await intent(a)).body;
    const ib = (await intent(b)).body;
    const sigA = pay(a, ia); // alice's genuine payment
    const { res, body } = await confirm(b, ib.intentId, sigA); // bob tries to use it for his intent
    expect(res.status).toBe(422);
    expect(['missing_reference', 'wrong_sender']).toContain(body.code);
    expect(b.account.inventory.genesis_pixel).toBeUndefined();
  });

  it('a signature cannot be replayed on a second intent, even if the transaction names both references', async () => {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    const i1 = (await intent(a, HOODIE.id)).body;
    const i2 = (await intent(a, PIXEL.id)).body;
    // one transfer of 10M lamports that includes BOTH references would satisfy both prices without the ledger
    const sig = pay(a, i1, { reference: [i1.reference, i2.reference], lamports: i2.lamports, memo: null });
    expect((await confirm(a, i1.intentId, sig)).res.status).toBe(200);
    const replay = await confirm(a, i2.intentId, sig);
    expect(replay.res.status).toBe(409);
    expect(replay.body.code).toBe('signature_reused');
    expect(a.account.inventory.genesis_pixel).toBeUndefined();
    expect(a.account.inventory.sunset_hoodie).toBe(1);
  });

  it('a settled intent refuses a different signature', async () => {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    const it = (await intent(a)).body;
    expect((await confirm(a, it.intentId, pay(a, it))).res.status).toBe(200);
    const again = await confirm(a, it.intentId, pay(a, it));
    expect(again.res.status).toBe(409);
    expect(again.body.code).toBe('already_fulfilled');
    expect(a.account.inventory.genesis_pixel).toBe(1);
  });

  it('malformed requests', async () => {
    const { a, it } = await setup();
    expect((await post(p!.base + '/api/pay/confirm', { intentId: it.intentId }, bearer(a.token))).status).toBe(400);
    expect((await post(p!.base + '/api/pay/confirm', { intentId: it.intentId, signature: 'x'.repeat(10) }, bearer(a.token))).status).toBe(400);
    expect((await confirm(a, it.intentId, '0'.repeat(88))).body.code).toBe('bad_signature'); // not base58
    expect((await confirm(a, it.intentId, bs58.encode(new Uint8Array(40).fill(3)) + 'z'.repeat(30))).res.status).toBeGreaterThanOrEqual(400);
    expect((await post(p!.base + '/api/pay/confirm', { intentId: it.intentId, signature: 's'.repeat(88) })).status).toBe(401);
    expect((await confirm(a, 'f'.repeat(32), pay(a, it))).body.code).toBe('unknown_intent');
    nothingGranted(a, it.intentId);
  });

  it('the wallet was unlinked or replaced after the intent was created', async () => {
    const { a, it } = await setup();
    const sig = pay(a, it);
    expect((await del(p!.base + '/api/wallet', bearer(a.token))).status).toBe(200);
    expect((await confirm(a, it.intentId, sig)).body.code).toBe('wallet_changed');
    const w2 = makeWallet();
    expect((await linkOverHttp(p!.base, a.token, w2)).status).toBe(200);
    expect((await confirm(a, it.intentId, sig)).body.code).toBe('wallet_changed');
    nothingGranted(a, it.intentId);
  });

  it('paying the treasury from the treasury itself proves nothing', async () => {
    const { a, it } = await setup();
    // make the player's linked wallet the treasury key (owner linking their own treasury) and pay "themselves"
    const sig = pay(a, it, { payer: p!.treasury });
    expect((await confirm(a, it.intentId, sig)).res.status).toBe(422);
    nothingGranted(a, it.intentId);
  });

  it('verified payment for something the player has meanwhile obtained: recorded, flagged, never granted twice', async () => {
    const { a, it } = await setup();
    const sig = pay(a, it);
    a.account.inventory.genesis_pixel = 1; // got it another way while the payment was in flight
    const { res, body } = await confirm(a, it.intentId, sig);
    expect(res.status).toBe(409);
    expect(body.code).toBe('paid_not_granted');
    expect(a.account.inventory.genesis_pixel).toBe(1);
    expect(p!.h.srv.db.findSignature(sig)).toMatchObject({ outcome: 'paid_not_granted' });
    expect(p!.h.srv.db.getIntent(it.intentId)!.status).toBe('paid_not_granted');
    // asking again gives the same answer and the signature stays burnt
    expect((await confirm(a, it.intentId, sig)).body.code).toBe('paid_not_granted');
    const next = await intent(a);
    expect(next.res.status).toBe(409); // already owned
  });
});

describe('cluster guard and persistence', () => {
  it('a non-devnet genesis hash blocks payment confirmation and intent creation', async () => {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    const it = (await intent(a)).body;
    const sig = pay(a, it);
    p.rpc.genesis = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'; // testnet
    const { res, body } = await confirm(a, it.intentId, sig);
    expect(res.status).toBe(503);
    expect(body.code).toBe('cluster_guard');
    expect(a.account.inventory.genesis_pixel).toBeUndefined();
    expect(p.rpc.txCalls).toBe(0); // never even asked for the transaction
    expect((await intent(a, HOODIE.id)).res.status).toBe(503);
    // sticky: even if the node suddenly claims to be devnet again, a restart is required
    p.rpc.genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
    expect((await confirm(a, it.intentId, sig)).res.status).toBe(503);
  });

  it('an unreachable node is not a verdict: the check is retried', async () => {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    const it = (await intent(a)).body;
    const sig = pay(a, it);
    p.rpc.failGenesis = true;
    const down = await confirm(a, it.intentId, sig);
    expect(down.res.status).toBe(503);
    expect(down.body.code).toBe('rpc_unavailable');
    p.rpc.failGenesis = false;
    expect((await confirm(a, it.intentId, sig)).res.status).toBe(200);
  });

  it('the used-signature ledger and settled intents survive a restart (replay-proof)', async () => {
    p = await bootPayments();
    const a = await player('alice', 'a@example.com');
    const it = (await intent(a)).body;
    const sig = pay(a, it);
    expect((await confirm(a, it.intentId, sig)).res.status).toBe(200);
    await p.h.srv.db.flush();

    const p2 = await bootPayments({ dataDir: p.h.dir });
    try {
      const acc = p2.h.srv.db.findByWallet(a.wallet.publicKey)!;
      expect(acc.inventory.genesis_pixel).toBe(1);
      expect(p2.h.srv.db.findSignature(sig)).toMatchObject({ intentId: it.intentId });
      // same signature, same intent: idempotent answer from the persisted receipt (the new mock node knows nothing)
      const token = a.token;
      const again = await post(p2.base + '/api/pay/confirm', { intentId: it.intentId, signature: sig }, bearer(token));
      expect(again.status).toBe(200);
      expect(((await again.json()) as { ok: boolean }).ok).toBe(true);
      expect(acc.inventory.genesis_pixel).toBe(1);
    } finally {
      await p2.close();
    }
  });
});

describe('full flow over HTTP only (challenge -> verify -> intent -> confirm -> /api/me)', () => {
  it('links, pays and shows the item in the account', async () => {
    p = await bootPayments();
    const { token } = p.h.signup('alice', 'a@example.com');
    const wallet = makeWallet();
    expect((await linkOverHttp(p.base, token, wallet)).status).toBe(200);

    const it = (await (await post(p.base + '/api/pay/intent', { itemId: 'explorer_cap' }, bearer(token))).json()) as PayIntentView;
    expect(it.lamports).toBe(2_000_000);
    const t = mockPaymentTx({ payer: wallet, treasury: p.treasury.publicKey, reference: it.reference, lamports: it.lamports, blockTimeMs: p.h.clock(), memo: it.memo });
    p.rpc.add(t.signature, t.tx);
    const done = await post(p.base + '/api/pay/confirm', { intentId: it.intentId, signature: t.signature }, bearer(token));
    expect(done.status).toBe(200);
    const me = (await (await fetch(p.base + '/api/me', { headers: bearer(token) })).json()) as { inventory: Record<string, number>; wallet: string };
    expect(me.inventory.explorer_cap).toBe(1);
    expect(me.wallet).toBe(wallet.publicKey);
  });
});

describe('RpcError helper', () => {
  it('is a transient error by default', () => {
    expect(new RpcError('x').transient).toBe(true);
  });
});
