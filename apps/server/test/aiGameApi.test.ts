import { afterEach, describe, expect, it } from 'vitest';
import { LOCATIONS, SPAWN, STARTING_COINS, locationById, shopItems, toShopItemView, walkDistance } from '@pixels/shared';
import { createAiGameApi, matchLocation } from '../src/aiGameApi';
import { makeHarness, type Harness, type TestClient } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

function apiFor(c: TestClient) {
  return createAiGameApi({ db: h.srv.db, game: h.srv.game, missions: h.srv.missions, shop: h.srv.shop }, c.id);
}

describe('player context', () => {
  it('describes the player without private data', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    await h.join('bobby', 'b@example.com');
    const ctx = apiFor(c).getPlayerContext();
    expect(ctx).toMatchObject({ displayName: c.account.displayName, x: SPAWN.x, z: SPAWN.z, coins: STARTING_COINS, playersOnline: 2, activeMission: null });
    expect(ctx.nearestLocation).toMatchObject({ id: 'plaza', distance: 0 });
    expect(JSON.stringify(ctx)).not.toContain('example.com');
    expect(JSON.stringify(ctx)).not.toContain(c.id);
  });

  it('lists nearby interactables within 12 m (including the shop counter) and hides hidden spots', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const shop = locationById('shop')!;
    c.teleport(shop.x, shop.z);
    const ctx = apiFor(c).getPlayerContext();
    const ids = ctx.nearbyInteractables.map((n) => n.id);
    expect(ids).toContain('shop');
    expect(ids).toContain('shop_counter');
    expect(ids.every((id) => !id.startsWith('ts_'))).toBe(true);
    expect(ctx.nearbyInteractables.every((n) => n.distance <= 12)).toBe(true);
    expect([...ctx.nearbyInteractables].sort((a, b) => a.distance - b.distance)).toEqual(ctx.nearbyInteractables);
    expect(ctx.nearestLocation!.id).toBe('shop');
  });

  it('includes the active mission and its current objective', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const offer = h.srv.missions.createOffer(c.id, { title: 'Bread run', description: 'Take bread to the cafe.', type: 'delivery', startLocationId: 'bakery', objectiveLocationIds: ['cafe'] });
    if (!offer.ok) throw new Error(offer.error);
    await c.send({ t: 'mission_accept', offerId: offer.offer.offerId });
    expect(apiFor(c).getPlayerContext().activeMission).toEqual({ title: 'Bread run', type: 'delivery', currentObjective: 'Pick up the parcel at Golden Crust Bakery' });
  });
});

describe('locations', () => {
  it('lists only public locations with distances', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const list = apiFor(c).listLocations();
    expect(list.map((l) => l.id).sort()).toEqual(LOCATIONS.filter((l) => !l.hidden).map((l) => l.id).sort());
    expect(list.find((l) => l.id === 'plaza')!.distance).toBe(0);
    expect(list.every((l) => l.description.length > 0)).toBe(true);
  });

  it.each([
    ['bakery', 'bakery'],
    ['Bakery', 'bakery'],
    ['  BAKERY  ', 'bakery'],
    ['golden crust', 'bakery'],
    ['Golden Crust Bakery', 'bakery'],
    ['café', 'cafe'],
    ['cafe', 'cafe'],
    ['coffee', 'cafe'],
    ['pixel market', 'shop'],
    ['store', 'shop'],
    ['the shop', 'shop'],
    ['post_office', 'post_office'],
    ['post off', 'post_office'],
    ['mail', 'post_office'],
    ['town hall', 'town_hall'],
    ['clock tower', 'town_hall'],
    ['lily pond', 'pond'],
    ['pon', 'pond'],
    ['take me to the library please', 'library'],
    ['where is the neon arcade?', 'arcade'],
    ['swings', 'playground'],
    ['gazebo', 'gazebo'],
    ['park', 'gazebo'],
  ])('finds %s -> %s', async (query, id) => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const found = apiFor(c).findLocation(query);
    expect(found?.id).toBe(id);
    expect(found).toMatchObject({ x: locationById(id)!.x, z: locationById(id)!.z });
  });

  it('returns null for unknown, too-short and hidden places (never revealing treasure spots)', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const api = apiFor(c);
    for (const q of ['', ' ', 'a', 'moon base', 'ts_oak', 'Old Oak Clearing', 'willow corner', 'ts_garden', 'garden hedge', 'quiet bench', 'lantern row']) {
      expect(api.findLocation(q), q).toBeNull();
    }
    expect(matchLocation('quiet bench')).toBeNull();
  });

  it('navigateTo validates the location and returns shared walking distance', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const api = apiFor(c);
    const r = api.navigateTo('library');
    if (!r.ok) throw new Error(r.error);
    const lib = locationById('library')!;
    expect(r.action).toEqual({
      type: 'navigate',
      locationId: 'library',
      label: 'Town Library',
      x: lib.x,
      z: lib.z,
      distance: Math.round(walkDistance(SPAWN, lib) * 10) / 10,
    });
    expect(api.navigateTo('nowhere')).toMatchObject({ ok: false });
    expect(api.navigateTo('ts_oak')).toMatchObject({ ok: false });
    expect(api.navigateTo('')).toMatchObject({ ok: false });
  });

  it('measures from the live position', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const lib = locationById('library')!;
    c.teleport(lib.x - 15, lib.z);
    const r = apiFor(c).navigateTo('library');
    if (!r.ok) throw new Error(r.error);
    expect(r.action.distance).toBeGreaterThan(14);
    expect(r.action.distance).toBeLessThan(25);
  });
});

describe('shop', () => {
  it('openShop and listShopItems come from the trusted catalogue', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const api = apiFor(c);
    expect(api.openShop()).toEqual({ ok: true, action: { type: 'open_shop' } });
    expect(api.listShopItems()).toEqual(shopItems().map(toShopItemView));
    expect(api.listShopItems().some((i) => i.id === 'explorer_badge')).toBe(false);
  });

  it('proposePurchase validates item, price and affordability but never buys', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const api = apiFor(c);
    expect(api.proposePurchase('coffee')).toEqual({ ok: true, action: { type: 'purchase_proposal', itemId: 'coffee', name: 'Pixel Coffee', price: 5, canAfford: true } });
    expect(api.proposePurchase('genesis_pixel')).toMatchObject({ ok: true, action: { price: 250, canAfford: false } });
    expect(api.proposePurchase('nonexistent')).toMatchObject({ ok: false });
    expect(api.proposePurchase('explorer_badge')).toMatchObject({ ok: false });
    c.account.inventory.explorer_cap = 1;
    expect(api.proposePurchase('explorer_cap')).toMatchObject({ ok: false });
    expect(c.account.coins).toBe(STARTING_COINS);
    expect(c.account.inventory).toEqual({ explorer_cap: 1 });
  });
});

describe('quests and players', () => {
  it('describes the three mission types', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const quests = apiFor(c).listAvailableQuests();
    expect(quests.map((q) => q.type)).toEqual(['visit_location', 'delivery', 'treasure_hunt']);
    for (const q of quests) {
      expect(q.description.length).toBeGreaterThan(20);
      expect(q.examples.length).toBeGreaterThan(0);
      expect(q.description).toMatch(/mock/i);
    }
  });

  it('createMissionOffer goes through the server validation', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const api = apiFor(c);
    const ok = api.createMissionOffer({ title: 'Go to the arcade', description: 'Walk to the Neon Arcade.', type: 'visit_location', startLocationId: 'plaza', objectiveLocationIds: ['arcade'], rewardId: 'reward_treasure', estimatedMinutes: 15 });
    if (!ok.ok) throw new Error(ok.error);
    expect(ok.offer.reward.coins).toBe(15);
    expect(api.createMissionOffer({ title: 'x', description: 'y', type: 'visit_location' } as never)).toMatchObject({ ok: false });
    expect(api.createMissionOffer({ title: 'Go there', description: 'Walk to a hidden spot.', type: 'visit_location', startLocationId: 'plaza', objectiveLocationIds: ['ts_oak'] })).toMatchObject({ ok: false });
  });

  it('findPlayers returns other online players by display name with distance rounded to 5 m, nothing else', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    const b = await h.join('bobby', 'b@example.com');
    const c = await h.join('carol', 'c@example.com');
    b.teleport(SPAWN.x + 12, SPAWN.z); // 12 -> 10
    c.teleport(SPAWN.x + 13, SPAWN.z); // 13 -> 15
    const players = apiFor(a).findPlayers();
    expect(players).toEqual([
      { name: b.account.displayName, distance: 10 },
      { name: c.account.displayName, distance: 15 },
    ]);
    const json = JSON.stringify(players);
    expect(json).not.toContain('example.com');
    expect(json).not.toContain(b.id);
    expect(Object.keys(players[0]).sort()).toEqual(['distance', 'name']);
    // an offline requester gets no distances
    h.srv.game.disconnect(a.session);
    expect(apiFor(a).findPlayers().every((p) => p.distance === null)).toBe(true);
  });
});
