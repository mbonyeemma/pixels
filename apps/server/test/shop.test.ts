import { afterEach, describe, expect, it } from 'vitest';
import { INTERACT_RADIUS, ITEMS, SHOP_COUNTER, STARTING_COINS, itemById, locationById } from '@pixels/shared';
import { MAX_STACK, coinsProvider, distanceToShopCounter, type PaymentProvider } from '../src/shop';
import { makeHarness, type Harness, type TestClient } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const shop = locationById('shop')!;

async function atShop(name = 'alice', email = 'a@example.com'): Promise<TestClient> {
  const c = await h.join(name, email);
  c.teleport(shop.x, shop.z);
  c.clear();
  return c;
}

describe('buying', () => {
  it('starts every account with STARTING_COINS and an empty inventory', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    expect(c.account.coins).toBe(STARTING_COINS);
    expect(c.account.inventory).toEqual({});
  });

  it('sells an item at the catalogue price, updates inventory and coins, and replies with shop_result + account', async () => {
    h = makeHarness();
    const c = await atShop();
    await c.send({ t: 'shop_buy', itemId: 'explorer_cap' });
    const price = itemById('explorer_cap')!.price!;
    expect(c.last('shop_result')).toMatchObject({ ok: true, itemId: 'explorer_cap', coins: STARTING_COINS - price });
    expect(c.last('account')).toEqual({ t: 'account', coins: STARTING_COINS - price, inventory: { explorer_cap: 1 }, equipped: {} });
    expect(c.account.coins).toBe(STARTING_COINS - price);
  });

  it('rejects purchases with insufficient coins and changes nothing', async () => {
    h = makeHarness();
    const c = await atShop();
    await c.send({ t: 'shop_buy', itemId: 'genesis_pixel' }); // 250 > 100
    expect(c.last('shop_result')).toMatchObject({ ok: false, itemId: 'genesis_pixel', coins: STARTING_COINS });
    expect(c.last('shop_result')!.message).toMatch(/not enough coins/i);
    expect(c.of('account')).toHaveLength(0);
    expect(c.account.inventory).toEqual({});
    expect(c.account.coins).toBe(STARTING_COINS);
  });

  it('refuses a second copy of a cosmetic / collectible / badge', async () => {
    h = makeHarness();
    const c = await atShop();
    c.account.coins = 1000;
    await c.send({ t: 'shop_buy', itemId: 'round_shades' });
    expect(c.last('shop_result')!.ok).toBe(true);
    await c.send({ t: 'shop_buy', itemId: 'round_shades' });
    expect(c.last('shop_result')).toMatchObject({ ok: false });
    expect(c.last('shop_result')!.message).toMatch(/already own/i);
    expect(c.account.inventory.round_shades).toBe(1);
    expect(c.account.coins).toBe(1000 - itemById('round_shades')!.price!);
    await c.send({ t: 'shop_buy', itemId: 'genesis_pixel' });
    await c.send({ t: 'shop_buy', itemId: 'genesis_pixel' });
    expect(c.account.inventory.genesis_pixel).toBe(1);
  });

  it('stacks consumables up to the cap', async () => {
    h = makeHarness();
    const c = await atShop();
    c.account.coins = 10_000;
    for (let i = 0; i < 3; i++) await c.send({ t: 'shop_buy', itemId: 'coffee' });
    expect(c.account.inventory.coffee).toBe(3);
    expect(c.account.coins).toBe(10_000 - 15);
    c.account.inventory.coffee = MAX_STACK;
    await c.send({ t: 'shop_buy', itemId: 'coffee' });
    expect(c.last('shop_result')).toMatchObject({ ok: false });
    expect(c.account.inventory.coffee).toBe(MAX_STACK);
  });

  it('requires the player to be near the counter (server-side position), within INTERACT_RADIUS + 1', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    // spawn is far away
    await c.send({ t: 'shop_buy', itemId: 'coffee' });
    expect(c.last('shop_result')).toMatchObject({ ok: false });
    expect(c.last('shop_result')!.message).toMatch(/counter/i);
    expect(c.account.inventory.coffee).toBeUndefined();

    // exactly at the edge of range works, a bit further does not
    const range = INTERACT_RADIUS + 1;
    c.teleport(SHOP_COUNTER.x + SHOP_COUNTER.w / 2 + range - 0.05, SHOP_COUNTER.z);
    await c.send({ t: 'shop_buy', itemId: 'coffee' });
    expect(c.last('shop_result')!.ok).toBe(true);
    c.teleport(SHOP_COUNTER.x + SHOP_COUNTER.w / 2 + range + 0.2, SHOP_COUNTER.z);
    await c.send({ t: 'shop_buy', itemId: 'coffee' });
    expect(c.last('shop_result')!.ok).toBe(false);
    expect(c.account.inventory.coffee).toBe(1);
  });

  it('cannot be tricked by a client-claimed position or price: only itemId is read', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    // client "moves" to the shop with a teleport: rejected by move validation, so the shop still sees the real position
    c.clear();
    h.clock.advance(100);
    await c.moveTo(shop.x, shop.z, 'run');
    expect(c.of('correct')).toHaveLength(1);
    await c.sendRaw(JSON.stringify({ t: 'shop_buy', itemId: 'explorer_cap', price: 0, coins: 99999, x: shop.x, z: shop.z }));
    expect(c.last('shop_result')!.ok).toBe(false);
    expect(c.account.coins).toBe(STARTING_COINS);

    // even with a forged price field next to a legitimate position the catalogue price is charged
    c.teleport(shop.x, shop.z);
    await c.sendRaw(JSON.stringify({ t: 'shop_buy', itemId: 'explorer_cap', price: 1 }));
    expect(c.account.coins).toBe(STARTING_COINS - itemById('explorer_cap')!.price!);
  });

  it('rejects unknown items and items that are not for sale', async () => {
    h = makeHarness();
    const c = await atShop();
    c.account.coins = 1000;
    await c.send({ t: 'shop_buy', itemId: 'does_not_exist' });
    expect(c.last('shop_result')).toMatchObject({ ok: false });
    await c.send({ t: 'shop_buy', itemId: 'explorer_badge' }); // reward-only, price null
    expect(c.last('shop_result')).toMatchObject({ ok: false });
    expect(c.last('shop_result')!.message).toMatch(/not for sale/i);
    expect(c.account.inventory).toEqual({});
    expect(c.account.coins).toBe(1000);
  });

  it('every item in the catalogue with a price can be bought exactly at its price', async () => {
    h = makeHarness();
    const c = await atShop();
    c.account.coins = 100_000;
    for (const item of ITEMS.filter((i) => i.price !== null)) {
      const before = c.account.coins;
      await c.send({ t: 'shop_buy', itemId: item.id });
      expect(c.last('shop_result')!.ok, item.id).toBe(true);
      expect(before - c.account.coins, item.id).toBe(item.price);
    }
  });

  it('persists purchases', async () => {
    h = makeHarness();
    const c = await atShop();
    await c.send({ t: 'shop_buy', itemId: 'coffee' });
    await h.srv.db.flush();
    const { Database } = await import('../src/db');
    const fresh = new Database({ dir: h.dir });
    fresh.load();
    const acc = fresh.getAccount(c.id)!;
    expect(acc.inventory).toEqual({ coffee: 1 });
    expect(acc.coins).toBe(STARTING_COINS - 5);
  });

  it('goes through the PaymentProvider seam (a different provider changes how it is paid, not what is sold)', async () => {
    const calls: { price: number; item: string }[] = [];
    const free: PaymentProvider = {
      id: 'test-free',
      async charge(_account, price, item) {
        calls.push({ price, item: item.id });
        return { ok: true };
      },
    };
    h = makeHarness({ paymentProvider: free });
    expect(h.srv.shop.paymentProviderId).toBe('test-free');
    const c = await atShop();
    await c.send({ t: 'shop_buy', itemId: 'sunset_hoodie' });
    expect(calls).toEqual([{ price: 120, item: 'sunset_hoodie' }]);
    expect(c.account.inventory.sunset_hoodie).toBe(1);
    expect(c.account.coins).toBe(STARTING_COINS); // this provider took no coins
  });

  it('serialises concurrent buys for one account while a charge is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: PaymentProvider = {
      id: 'slow',
      async charge(account, price) {
        await gate;
        return coinsProvider.charge(account, price, itemById('coffee')!);
      },
    };
    h = makeHarness({ paymentProvider: slow });
    const c = await atShop();
    const first = c.send({ t: 'shop_buy', itemId: 'coffee' });
    await c.send({ t: 'shop_buy', itemId: 'coffee' }); // second request while the first is in flight
    expect(c.last('shop_result')).toMatchObject({ ok: false });
    expect(c.last('shop_result')!.message).toMatch(/in progress/i);
    release();
    await first;
    expect(c.account.inventory.coffee).toBe(1);
    expect(c.account.coins).toBe(STARTING_COINS - 5);
  });

  it('a declined or throwing provider charge leaves the inventory untouched', async () => {
    let mode: 'decline' | 'throw' = 'decline';
    const flaky: PaymentProvider = {
      id: 'flaky',
      async charge() {
        if (mode === 'throw') throw new Error('network down');
        return { ok: false, reason: 'Payment declined.' };
      },
    };
    h = makeHarness({ paymentProvider: flaky });
    const c = await atShop();
    await c.send({ t: 'shop_buy', itemId: 'coffee' });
    expect(c.last('shop_result')).toMatchObject({ ok: false, message: 'Payment declined.' });
    mode = 'throw';
    await c.send({ t: 'shop_buy', itemId: 'coffee' });
    expect(c.last('shop_result')).toMatchObject({ ok: false });
    expect(c.account.inventory).toEqual({});
    // and the account is not stuck "in progress"
    mode = 'decline';
    await c.send({ t: 'shop_buy', itemId: 'coffee' });
    expect(c.last('shop_result')!.message).toBe('Payment declined.');
  });

  it('distanceToShopCounter is 0 on the counter and grows outside it', () => {
    expect(distanceToShopCounter(SHOP_COUNTER.x, SHOP_COUNTER.z)).toBe(0);
    expect(distanceToShopCounter(SHOP_COUNTER.x + SHOP_COUNTER.w / 2 + 3, SHOP_COUNTER.z)).toBeCloseTo(3);
    expect(distanceToShopCounter(SHOP_COUNTER.x, SHOP_COUNTER.z + SHOP_COUNTER.d / 2 + 2)).toBeCloseTo(2);
  });
});

describe('interact shop_counter', () => {
  it('is a no-op near the counter and a warning toast when too far', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    await c.send({ t: 'interact', target: 'shop_counter' });
    expect(c.last('toast')).toMatchObject({ level: 'warn' });
    c.clear();
    c.teleport(shop.x, shop.z);
    await c.send({ t: 'interact', target: 'shop_counter' });
    expect(c.messages).toHaveLength(0);
  });
});

describe('equip', () => {
  async function owner(): Promise<TestClient> {
    const c = await atShop();
    c.account.coins = 1000;
    for (const id of ['explorer_cap', 'round_shades', 'coffee', 'genesis_pixel']) await c.send({ t: 'shop_buy', itemId: id });
    c.clear();
    return c;
  }

  it('equips an owned cosmetic in the matching slot, sends account and broadcasts appearance', async () => {
    h = makeHarness();
    const c = await owner();
    const other = await h.join('bobby', 'b@example.com');
    other.clear();
    await c.send({ t: 'equip', slot: 'hat', itemId: 'explorer_cap' });
    expect(c.last('account')!.equipped).toEqual({ hat: 'explorer_cap' });
    expect(other.last('appearance')).toEqual({ t: 'appearance', id: c.id, equipped: { hat: 'explorer_cap' } });
    expect(c.account.equipped).toEqual({ hat: 'explorer_cap' });
    // equipped items appear in views for new joiners
    const late = await h.join('carol', 'c@example.com');
    expect(late.last('welcome')!.players.find((p) => p.id === c.id)!.equipped).toEqual({ hat: 'explorer_cap' });
  });

  it('rejects wrong slot, unowned, non-wearable and unknown items', async () => {
    h = makeHarness();
    const c = await owner();
    const other = await h.join('bobby', 'b@example.com');
    other.clear();
    for (const [slot, itemId] of [
      ['face', 'explorer_cap'], // wrong slot
      ['jacket', 'sunset_hoodie'], // not owned
      ['hat', 'coffee'], // consumable
      ['hat', 'genesis_pixel'], // collectible
      ['hat', 'nope'], // unknown
    ] as const) {
      c.clear();
      await c.send({ t: 'equip', slot, itemId });
      expect(c.last('toast'), `${slot}/${itemId}`).toMatchObject({ level: 'warn' });
    }
    expect(c.account.equipped).toEqual({});
    expect(other.of('appearance')).toHaveLength(0);
  });

  it('null unequips the slot', async () => {
    h = makeHarness();
    const c = await owner();
    await c.send({ t: 'equip', slot: 'face', itemId: 'round_shades' });
    await c.send({ t: 'equip', slot: 'hat', itemId: 'explorer_cap' });
    c.clear();
    await c.send({ t: 'equip', slot: 'face', itemId: null });
    expect(c.account.equipped).toEqual({ hat: 'explorer_cap' });
    expect(c.last('account')!.equipped).toEqual({ hat: 'explorer_cap' });
  });

  it('rejects slots outside the allowed list at the schema level', async () => {
    h = makeHarness();
    const c = await owner();
    await c.sendRaw('{"t":"equip","slot":"cape","itemId":"explorer_cap"}');
    expect(c.account.equipped).toEqual({});
  });
});
