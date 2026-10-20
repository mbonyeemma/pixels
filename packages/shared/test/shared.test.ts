import { describe, expect, it } from 'vitest';
import {
  COLLIDERS, LOCATIONS, PLAYER_RADIUS, SPAWN, findPath, isBlocked, resolveCollisions, validateMissionProposal, walkDistance,
  BUILDINGS, PROPS, ClientMessageSchema, worldTimeOfDay, PICKUP_LOCATION_IDS, DROPOFF_LOCATION_IDS, locationById, SHOP_COUNTER, MISSION_LIMITS,
  ITEMS, shopItems, toShopItemView, hasLamportPrice, itemById, LAMPORTS_PER_SOL, DEVNET_LABEL, DEVNET_GENESIS_HASH,
} from '../src';

describe('world data', () => {
  it('has free spawn, locations and no overlapping buildings', () => {
    expect(isBlocked(SPAWN.x, SPAWN.z, PLAYER_RADIUS, COLLIDERS)).toBe(false);
    for (const l of LOCATIONS) expect(isBlocked(l.x, l.z, PLAYER_RADIUS, COLLIDERS), `${l.id} is free`).toBe(false);
    for (const a of BUILDINGS) for (const b of BUILDINGS) {
      if (a === b) continue;
      const overlap = Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.z - b.z) < (a.d + b.d) / 2;
      expect(overlap, `${a.id}/${b.id}`).toBe(false);
    }
    expect(PROPS.length).toBeGreaterThan(80);
  });
  it('every location is reachable from spawn', () => {
    for (const l of LOCATIONS) expect(Number.isFinite(walkDistance(SPAWN, l)), l.id).toBe(true);
  });
  it('shop location is within interaction range of the counter', () => {
    const shop = locationById('shop')!;
    expect(Math.hypot(shop.x - SHOP_COUNTER.x, shop.z - SHOP_COUNTER.z)).toBeLessThan(3.5);
  });
});

describe('collision', () => {
  it('pushes the player out of a building', () => {
    const b = BUILDINGS.find((x) => x.id === 'town_hall')!;
    const [x, z] = resolveCollisions(b.x, b.z, PLAYER_RADIUS, COLLIDERS);
    expect(isBlocked(x, z, PLAYER_RADIUS - 0.01, COLLIDERS)).toBe(false);
  });
  it('clamps to the world bounds', () => {
    const [x, z] = resolveCollisions(500, -500, PLAYER_RADIUS, COLLIDERS);
    expect(x).toBeLessThanOrEqual(58);
    expect(z).toBeGreaterThanOrEqual(-58);
  });
});

describe('pathfinding', () => {
  it('routes around buildings with waypoints that never end inside a collider', () => {
    const path = findPath(SPAWN, locationById('shop')!)!;
    expect(path.length).toBeGreaterThan(0);
    for (const p of path) expect(isBlocked(p.x, p.z, PLAYER_RADIUS - 0.05, COLLIDERS)).toBe(false);
  });
});

describe('mission proposal validation', () => {
  const ok = { title: 'Fountain visit', description: 'Walk to the fountain and enjoy the view.', type: 'visit_location', startLocationId: 'plaza', objectiveLocationIds: ['fountain'] };
  it('accepts valid proposals and forces fixed rewards', () => {
    const r = validateMissionProposal({ ...ok, rewardId: 'reward_treasure', estimatedMinutes: 9999 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.proposal.rewardId).toBe('reward_visit');
      expect(r.proposal.estimatedMinutes).toBe(MISSION_LIMITS.maxMinutes);
    }
  });
  it('rejects unknown locations, wrong types and bad shapes', () => {
    expect(validateMissionProposal({ ...ok, objectiveLocationIds: ['moon_base'] }).ok).toBe(false);
    expect(validateMissionProposal({ ...ok, type: 'teleport' }).ok).toBe(false);
    expect(validateMissionProposal({ ...ok, objectiveLocationIds: ['ts_oak'] }).ok).toBe(false);
    expect(validateMissionProposal({ ...ok, type: 'delivery', startLocationId: 'library', objectiveLocationIds: ['cafe'] }).ok).toBe(false);
    expect(validateMissionProposal({ ...ok, type: 'delivery', startLocationId: PICKUP_LOCATION_IDS[0], objectiveLocationIds: [PICKUP_LOCATION_IDS[0]] }).ok).toBe(false);
    expect(validateMissionProposal({ ...ok, type: 'delivery', startLocationId: 'bakery', objectiveLocationIds: [DROPOFF_LOCATION_IDS[0]] }).ok).toBe(true);
    expect(validateMissionProposal({ ...ok, type: 'treasure_hunt', objectiveLocationIds: ['ts_oak'] }).ok).toBe(false);
    expect(validateMissionProposal({ ...ok, type: 'treasure_hunt', objectiveLocationIds: ['ts_oak', 'ts_path', 'ts_bench'] }).ok).toBe(true);
    expect(validateMissionProposal(null).ok).toBe(false);
  });
  it('strips markup from text', () => {
    const r = validateMissionProposal({ ...ok, title: '<script>x</script> Visit' });
    expect(r.ok && !/[<>]/.test(r.proposal.title)).toBe(true);
  });
});

describe('protocol', () => {
  it('validates client messages', () => {
    expect(ClientMessageSchema.safeParse({ t: 'move', x: 1, z: 2, ry: 0, anim: 'walk', seq: 1 }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ t: 'move', x: NaN, z: 2, ry: 0, anim: 'walk', seq: 1 }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ t: 'move', x: 1, z: 2, ry: 0, anim: 'fly', seq: 1 }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ t: 'hack' }).success).toBe(false);
  });
  it('computes time of day', () => {
    expect(worldTimeOfDay(0, 1200)).toBe(0);
    expect(worldTimeOfDay(600_000, 1200)).toBeCloseTo(0.5);
  });
});

describe('devnet lamport prices (optional payments)', () => {
  it('only a few items carry a lamport price, all with a valid coin price too (payable both ways)', () => {
    const priced = ITEMS.filter(hasLamportPrice);
    expect(priced.map((i) => i.id).sort()).toEqual(['explorer_cap', 'genesis_pixel', 'sunset_hoodie']);
    for (const i of priced) {
      expect(Number.isSafeInteger(i.priceLamports)).toBe(true);
      expect(i.priceLamports).toBeGreaterThan(0);
      // test-network amounts stay tiny: never more than 0.05 SOL
      expect(i.priceLamports).toBeLessThanOrEqual(0.05 * LAMPORTS_PER_SOL);
      expect(i.price).not.toBeNull();
    }
    expect(itemById('genesis_pixel')!.priceLamports).toBe(10_000_000);
    expect(itemById('sunset_hoodie')!.priceLamports).toBe(5_000_000);
    expect(itemById('explorer_cap')!.priceLamports).toBe(2_000_000);
  });

  it('keeps the coin prices unchanged', () => {
    expect(Object.fromEntries(ITEMS.map((i) => [i.id, i.price]))).toEqual({
      coffee: 5, explorer_cap: 40, round_shades: 60, neon_sneakers: 80, sunset_hoodie: 120, genesis_pixel: 250, explorer_badge: null,
    });
  });

  it('exposes priceLamports on the view only when the item has one', () => {
    const views = shopItems().map(toShopItemView);
    expect(views.find((v) => v.id === 'genesis_pixel')!.priceLamports).toBe(10_000_000);
    expect('priceLamports' in views.find((v) => v.id === 'coffee')!).toBe(false);
    expect(views.find((v) => v.id === 'coffee')!.price).toBe(5);
  });

  it('hasLamportPrice rejects missing, zero, negative, fractional and unsafe values', () => {
    const base = ITEMS[0];
    for (const bad of [undefined, 0, -1, 1.5, Number.NaN, 2 ** 60]) expect(hasLamportPrice({ ...base, priceLamports: bad as number })).toBe(false);
    expect(hasLamportPrice({ ...base, priceLamports: 1 })).toBe(true);
  });

  it('labels and constants', () => {
    expect(DEVNET_LABEL).toBe('DEVNET TEST — no real value');
    expect(DEVNET_GENESIS_HASH).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });
});
