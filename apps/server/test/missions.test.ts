import { afterEach, describe, expect, it } from 'vitest';
import {
  ARRIVE_RADIUS,
  INTERACT_RADIUS,
  MISSION_LIMITS,
  REWARDS,
  SPAWN,
  STARTING_COINS,
  WALK_SPEED,
  locationById,
  walkDistance,
  type MissionOfferView,
  type MissionProposalInput,
} from '@pixels/shared';
import { dayKey } from '../src/util';
import { makeHarness, type Harness, type TestClient } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const visit = (to = 'arcade', over: Partial<MissionProposalInput> = {}): MissionProposalInput => ({
  title: 'Visit the arcade',
  description: 'Walk over to the Neon Arcade and take a look.',
  type: 'visit_location',
  startLocationId: 'plaza',
  objectiveLocationIds: [to],
  ...over,
});
const delivery = (from = 'bakery', to = 'cafe', over: Partial<MissionProposalInput> = {}): MissionProposalInput => ({
  title: 'Bread delivery',
  description: 'Take fresh bread from the bakery to the cafe.',
  type: 'delivery',
  startLocationId: from,
  objectiveLocationIds: [to],
  ...over,
});
const hunt = (spots = ['ts_path', 'ts_bench', 'ts_oak'], over: Partial<MissionProposalInput> = {}): MissionProposalInput => ({
  title: 'Park treasure hunt',
  description: 'Find the hidden spots in the park.',
  type: 'treasure_hunt',
  startLocationId: 'gazebo',
  objectiveLocationIds: spots,
  ...over,
});

function offerOf(c: TestClient, proposal: MissionProposalInput): MissionOfferView {
  const r = h.srv.missions.createOffer(c.id, proposal);
  if (!r.ok) throw new Error('offer failed: ' + r.error);
  return r.offer;
}
async function start(c: TestClient, proposal: MissionProposalInput): Promise<MissionOfferView> {
  const offer = offerOf(c, proposal);
  c.clear();
  await c.send({ t: 'mission_accept', offerId: offer.offerId });
  expect(c.last('mission')!.event, 'accepted').toBe('accepted');
  return offer;
}
const lastEvent = (c: TestClient) => c.last('mission')!;
const loc = (id: string) => locationById(id)!;

describe('offers', () => {
  it('validates, stores one pending offer and computes duration + reward on the server (never from the proposal)', () => {
    h = makeHarness();
    return h.join('alice', 'a@example.com').then((c) => {
      const o = offerOf(c, visit('arcade', { estimatedMinutes: 15, rewardId: 'reward_treasure' }));
      const dist = walkDistance(SPAWN, loc('arcade'));
      const minutes = Math.min(MISSION_LIMITS.maxMinutes, Math.max(MISSION_LIMITS.minMinutes, Math.ceil(dist / (WALK_SPEED * 0.8) / 60)));
      expect(o.estimatedMinutes).toBe(minutes);
      expect(o.reward).toEqual({ label: REWARDS.reward_visit.label, coins: 15, itemId: undefined, mock: true });
      expect(o.type).toBe('visit_location');
      expect(o.objectives).toEqual(['Visit Neon Arcade']);
      expect(o.expiresAt).toBe(h.clock() + MISSION_LIMITS.offerTtlMs);
      expect(o.offerId).toMatch(/^offer_/);
    });
  });

  it('server-computed estimate follows walking distance (long treasure route takes longer than the 1 minute floor)', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const spots = ['ts_oak', 'ts_slide', 'ts_lamp'];
    let from: { x: number; z: number } = SPAWN;
    let total = 0;
    for (const s of spots) {
      total += walkDistance(from, loc(s));
      from = loc(s);
    }
    expect(total).toBeLessThan(MISSION_LIMITS.maxTotalDistance); // setup sanity
    const o = offerOf(c, hunt(spots, { estimatedMinutes: 1 }));
    expect(o.estimatedMinutes).toBe(Math.ceil(total / (WALK_SPEED * 0.8) / 60));
    expect(o.estimatedMinutes).toBeGreaterThan(1);
    // treasure objectives are generic in the offer (no hidden place names)
    expect(o.objectives.join(' ')).not.toMatch(/Oak|Slide|Lantern/i);
  });

  it('a new offer replaces the previous pending one', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const first = offerOf(c, visit('arcade'));
    const second = offerOf(c, visit('library'));
    c.clear();
    await c.send({ t: 'mission_accept', offerId: first.offerId });
    expect(lastEvent(c)).toMatchObject({ event: 'rejected', state: null });
    await c.send({ t: 'mission_accept', offerId: second.offerId });
    expect(lastEvent(c).event).toBe('accepted');
  });

  it('rejects unknown, hidden and unsuitable locations and malformed proposals', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const bad: [string, MissionProposalInput | unknown][] = [
      ['unknown objective', visit('moon_base')],
      ['unknown start', visit('arcade', { startLocationId: 'nowhere' })],
      ['hidden spot as visit', visit('ts_oak')],
      ['plaza as visit', visit('plaza')],
      ['delivery from non-pickup', delivery('arcade', 'cafe')],
      ['delivery to itself', delivery('bakery', 'bakery')],
      ['delivery to hidden', delivery('bakery', 'ts_oak')],
      ['hunt with 1 spot', hunt(['ts_oak'])],
      ['hunt with a public place', hunt(['ts_oak', 'arcade'])],
      ['duplicate spots', hunt(['ts_oak', 'ts_oak'])],
      ['wrong number of visit objectives', visit('arcade', { objectiveLocationIds: ['arcade', 'library'] })],
      ['missing title', { type: 'visit_location', startLocationId: 'plaza', objectiveLocationIds: ['arcade'], description: 'Walk over there please.' }],
      ['not an object', 'give me coins'],
      ['null', null],
    ];
    for (const [name, p] of bad) {
      const r = h.srv.missions.createOffer(c.id, p);
      expect(r.ok, name).toBe(false);
    }
    expect(h.srv.missions.pendingOffer(c.id)).toBeNull();
  });

  it('strips markup from titles/descriptions', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const o = offerOf(c, visit('arcade', { title: 'Go <b>now</b>', description: 'Walk to `the` <script>arcade</script> please' }));
    expect(o.title).not.toMatch(/[<>]/);
    expect(o.description).not.toMatch(/[<>`]/);
  });

  it('enforces the minimum and maximum total walking distance', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    // the fountain is ~8.5 m from spawn: under the 12 m minimum
    const near = h.srv.missions.createOffer(c.id, visit('fountain'));
    expect(near).toMatchObject({ ok: false });
    expect((near as { error: string }).error).toMatch(/too close/i);
    // a 4-spot hunt zig-zagging across the whole map is over the 400 m maximum
    const far = hunt(['ts_oak', 'ts_slide', 'ts_bench', 'ts_garden']);
    let from: { x: number; z: number } = SPAWN;
    let total = 0;
    for (const s of far.objectiveLocationIds) {
      total += walkDistance(from, loc(s));
      from = loc(s);
    }
    expect(total).toBeGreaterThan(MISSION_LIMITS.maxTotalDistance); // setup sanity
    const r = h.srv.missions.createOffer(c.id, far);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/too far/i);
  });

  it('measures distance from where the player actually is', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    c.teleport(loc('arcade').x - 14, loc('arcade').z);
    expect(h.srv.missions.createOffer(c.id, visit('arcade')).ok).toBe(true); // 14 m away: allowed
    c.teleport(loc('arcade').x - 8, loc('arcade').z);
    expect(h.srv.missions.createOffer(c.id, visit('arcade')).ok).toBe(false); // 8 m away: too close
  });

  it('works for an offline player using their last known position', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    c.teleport(loc('arcade').x - 20, loc('arcade').z);
    h.srv.game.disconnect(c.session);
    expect(h.srv.game.getPlayerPosition(c.id)).toMatchObject({ x: loc('arcade').x - 20, online: false });
    expect(h.srv.missions.createOffer(c.id, visit('arcade')).ok).toBe(true);
  });

  it('offers expire after the TTL', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const o = offerOf(c, visit());
    h.clock.advance(MISSION_LIMITS.offerTtlMs + 1);
    c.clear();
    await c.send({ t: 'mission_accept', offerId: o.offerId });
    expect(lastEvent(c)).toMatchObject({ event: 'rejected' });
    expect(h.srv.missions.pendingOffer(c.id)).toBeNull();
  });

  it("one player cannot accept another player's offer", async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    const b = await h.join('bobby', 'b@example.com');
    const o = offerOf(a, visit());
    b.clear();
    await b.send({ t: 'mission_accept', offerId: o.offerId });
    expect(lastEvent(b).event).toBe('rejected');
    expect(b.account.activeMission).toBeNull();
    // and alice's offer is still valid
    a.clear();
    await a.send({ t: 'mission_accept', offerId: o.offerId });
    expect(lastEvent(a).event).toBe('accepted');
  });
});

describe('visit_location', () => {
  it('completes automatically on arrival (driven through validated moves) and pays the configured reward once', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    await start(c, visit('arcade'));
    const state = lastEvent(c).state!;
    expect(state.objectives).toEqual([{ id: 'arcade', kind: 'goto', label: 'Visit Neon Arcade', x: loc('arcade').x, z: loc('arcade').z, done: false }]);
    expect(state.reward.mock).toBe(true);
    await c.walkTo(loc('arcade').x, loc('arcade').z);
    const done = lastEvent(c);
    expect(done.event).toBe('completed');
    expect(done.state).toBeNull();
    expect(done.reward).toMatchObject({ coins: 15, mock: true });
    expect(c.last('account')).toMatchObject({ coins: STARTING_COINS + 15 });
    expect(c.account.coins).toBe(STARTING_COINS + 15);
    expect(c.account.activeMission).toBeNull();
    // loitering afterwards pays nothing more
    c.clear();
    h.clock.advance(100);
    await c.moveTo(c.x + 0.2, c.z);
    expect(c.of('mission')).toHaveLength(0);
    expect(c.account.coins).toBe(STARTING_COINS + 15);
  });

  it('arrival is checked against ARRIVE_RADIUS using the server position', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    await start(c, visit('arcade'));
    const a = loc('arcade');
    c.teleport(a.x + ARRIVE_RADIUS + 0.3, a.z);
    h.clock.advance(100);
    await c.moveTo(a.x + ARRIVE_RADIUS + 0.2, a.z);
    expect(c.account.activeMission).not.toBeNull();
    h.clock.advance(100);
    await c.moveTo(a.x + ARRIVE_RADIUS - 0.2, a.z);
    expect(c.account.activeMission).toBeNull();
    expect(lastEvent(c).event).toBe('completed');
  });

  it('a forged teleport to the destination does not complete it (the move is corrected)', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    await start(c, visit('arcade'));
    h.clock.advance(100);
    await c.moveTo(loc('arcade').x, loc('arcade').z, 'run');
    expect(c.of('correct')).toHaveLength(1);
    expect(c.account.activeMission).not.toBeNull();
    expect(c.account.coins).toBe(STARTING_COINS);
  });

  it('interact cannot be used to complete a goto objective', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    await start(c, visit('arcade'));
    c.teleport(loc('arcade').x + 10, loc('arcade').z);
    c.clear();
    await c.send({ t: 'interact', target: 'arcade' });
    expect(lastEvent(c).event).toBe('rejected');
    expect(c.account.activeMission).not.toBeNull();
  });

  it('completes straight away if the player is already at the destination when accepting', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const offer = offerOf(c, visit('arcade'));
    c.teleport(loc('arcade').x, loc('arcade').z);
    c.clear();
    await c.send({ t: 'mission_accept', offerId: offer.offerId });
    expect(c.of('mission').map((m) => m.event)).toEqual(['accepted', 'completed']);
  });
});

describe('delivery', () => {
  it('pickup then dropoff, with interact validated against position, order and mission state', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    await start(c, delivery('bakery', 'cafe'));
    const s = lastEvent(c).state!;
    expect(s.type).toBe('delivery');
    expect(s.objectives.map((o) => [o.id, o.kind, o.done])).toEqual([
      ['bakery', 'pickup', false],
      ['cafe', 'dropoff', false],
    ]);
    expect(s.objectives[0]).toMatchObject({ x: loc('bakery').x, z: loc('bakery').z });
    expect(s.current).toBe(0);

    // too far from the pickup
    c.clear();
    await c.send({ t: 'interact', target: 'bakery' });
    expect(lastEvent(c).event).toBe('rejected');
    expect(lastEvent(c).message).toMatch(/too far/i);

    await c.walkTo(loc('bakery').x, loc('bakery').z);
    expect(c.account.activeMission!.current).toBe(0); // arriving is not enough: delivery needs an explicit interact

    // out of order: drop-off before pickup
    c.clear();
    await c.send({ t: 'interact', target: 'cafe' });
    expect(lastEvent(c).event).toBe('rejected');

    c.clear();
    await c.send({ t: 'interact', target: 'bakery' });
    expect(lastEvent(c)).toMatchObject({ event: 'progress' });
    expect(lastEvent(c).state!.current).toBe(1);
    expect(lastEvent(c).state!.objectives[0].done).toBe(true);

    // carrying the parcel, but not at the cafe yet
    c.clear();
    await c.send({ t: 'interact', target: 'cafe' });
    expect(lastEvent(c).event).toBe('rejected');
    expect(c.account.activeMission).not.toBeNull();

    await c.walkTo(loc('cafe').x, loc('cafe').z);
    c.clear();
    await c.send({ t: 'interact', target: 'cafe' });
    expect(c.of('mission').map((m) => m.event)).toEqual(['completed']);
    expect(c.last('account')).toMatchObject({ coins: STARTING_COINS + 40 });
    expect(lastEvent(c).reward).toMatchObject({ coins: 40, mock: true });
  });

  it('interact range is INTERACT_RADIUS (plus a small slack for position lag)', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    await start(c, delivery('bakery', 'cafe'));
    const b = loc('bakery');
    c.teleport(b.x + INTERACT_RADIUS + 1.5, b.z);
    c.clear();
    await c.send({ t: 'interact', target: 'bakery' });
    expect(lastEvent(c).event).toBe('rejected');
    c.teleport(b.x + INTERACT_RADIUS - 0.1, b.z);
    c.clear();
    await c.send({ t: 'interact', target: 'bakery' });
    expect(lastEvent(c).event).toBe('progress');
  });

  it('unknown and non-objective targets are rejected without state change', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    await start(c, delivery('post_office', 'library'));
    c.teleport(loc('post_office').x, loc('post_office').z);
    for (const target of ['nonsense', 'library', 'ts_oak', 'plaza', '../../etc']) {
      c.clear();
      await c.send({ t: 'interact', target });
      expect(lastEvent(c).event, target).toBe('rejected');
    }
    expect(c.account.activeMission!.current).toBe(0);
  });
});

describe('treasure_hunt', () => {
  it('reveals spots one at a time, in order, with the right reward (coins + badge)', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const spots = ['ts_path', 'ts_bench', 'ts_oak'];
    await start(c, hunt(spots));
    let s = lastEvent(c).state!;
    expect(s.objectives).toHaveLength(1);
    expect(s.objectives[0]).toMatchObject({ id: 'ts_path', kind: 'collect', x: loc('ts_path').x, z: loc('ts_path').z, done: false });
    expect(JSON.stringify(s)).not.toContain('ts_oak'); // later spots stay hidden

    // out of order: the second spot while standing on it, but the first is current
    c.teleport(loc('ts_bench').x, loc('ts_bench').z);
    c.clear();
    await c.send({ t: 'interact', target: 'ts_bench' });
    expect(lastEvent(c).event).toBe('rejected');
    expect(c.account.activeMission!.current).toBe(0);

    for (let i = 0; i < spots.length; i++) {
      await c.walkTo(loc(spots[i]).x, loc(spots[i]).z);
      c.clear();
      await c.send({ t: 'interact', target: spots[i] });
      if (i < spots.length - 1) {
        s = lastEvent(c).state!;
        expect(lastEvent(c).event).toBe('progress');
        expect(s.objectives).toHaveLength(i + 2);
        expect(s.objectives[i + 1].id).toBe(spots[i + 1]);
        expect(s.current).toBe(i + 1);
      }
    }
    expect(lastEvent(c).event).toBe('completed');
    expect(lastEvent(c).reward).toMatchObject({ coins: 80, itemId: 'explorer_badge', mock: true });
    expect(c.account.coins).toBe(STARTING_COINS + 80);
    expect(c.account.inventory.explorer_badge).toBe(1);
    expect(c.last('account')!.inventory.explorer_badge).toBe(1);
  });

  it('a second hunt pays coins but does not duplicate the one-per-account badge', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    c.account.inventory.explorer_badge = 1;
    const spots = ['ts_path', 'ts_bench'];
    await start(c, hunt(spots));
    for (const sp of spots) {
      c.teleport(loc(sp).x, loc(sp).z);
      await c.send({ t: 'interact', target: sp });
    }
    expect(lastEvent(c).event).toBe('completed');
    expect(lastEvent(c).reward!.itemId).toBeUndefined();
    expect(lastEvent(c).reward!.label).not.toMatch(/Badge/);
    expect(c.account.inventory.explorer_badge).toBe(1);
    expect(c.account.coins).toBe(STARTING_COINS + 80);
  });

  it('too-far interact on the current spot is rejected', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    await start(c, hunt(['ts_path', 'ts_bench']));
    c.teleport(loc('ts_path').x + 9, loc('ts_path').z);
    c.clear();
    await c.send({ t: 'interact', target: 'ts_path' });
    expect(lastEvent(c).event).toBe('rejected');
    expect(lastEvent(c).message).toMatch(/too far/i);
  });
});

describe('forgery, replay and accounting', () => {
  it('interact with no active mission is rejected', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    c.clear();
    await c.send({ t: 'interact', target: 'bakery' });
    expect(lastEvent(c)).toMatchObject({ event: 'rejected', state: null });
    expect(c.account.coins).toBe(STARTING_COINS);
  });

  it('accepting with a made-up offer id is rejected', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    offerOf(c, visit());
    c.clear();
    await c.send({ t: 'mission_accept', offerId: 'offer_0000000000000000' });
    expect(lastEvent(c).event).toBe('rejected');
    expect(c.account.activeMission).toBeNull();
  });

  it('an offer can only be accepted once; replaying the accept or the final interact pays nothing extra', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const offer = await start(c, delivery('bakery', 'cafe'));
    c.teleport(loc('bakery').x, loc('bakery').z);
    await c.send({ t: 'interact', target: 'bakery' });
    c.teleport(loc('cafe').x, loc('cafe').z);
    await c.send({ t: 'interact', target: 'cafe' });
    expect(lastEvent(c).event).toBe('completed');
    expect(c.account.coins).toBe(STARTING_COINS + 40);

    // replay everything
    h.clock.advance(60_000);
    c.clear();
    await c.send({ t: 'interact', target: 'cafe' });
    await c.send({ t: 'interact', target: 'bakery' });
    await c.send({ t: 'mission_accept', offerId: offer.offerId });
    expect(c.of('mission').every((m) => m.event === 'rejected')).toBe(true);
    expect(c.account.coins).toBe(STARTING_COINS + 40);
    expect(c.account.activeMission).toBeNull();
  });

  it('the claim ledger blocks a double payout even if a finished mission is somehow resurrected', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    await start(c, visit('arcade'));
    const snapshot = structuredClone(c.account.activeMission!);
    c.teleport(loc('arcade').x, loc('arcade').z);
    h.clock.advance(100);
    await c.moveTo(loc('arcade').x, loc('arcade').z + 0.1);
    expect(lastEvent(c).event).toBe('completed');
    expect(Object.keys(c.account.missionClaims)).toEqual([snapshot.id]);
    const coins = c.account.coins;

    // resurrect (e.g. a restored backup or a crash between payout and clearing)
    c.account.activeMission = snapshot;
    c.clear();
    h.clock.advance(100);
    await c.moveTo(loc('arcade').x, loc('arcade').z);
    expect(lastEvent(c).event).toBe('rejected');
    expect(lastEvent(c).message).toMatch(/already completed/i);
    expect(c.account.coins).toBe(coins);
    expect(c.account.activeMission).toBeNull();
  });

  it('only one active mission at a time; offers and accepts are refused while one is running', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const second = offerOf(c, delivery('post_office', 'library'));
    await start(c, visit('arcade'));
    const r = h.srv.missions.createOffer(c.id, visit('library'));
    expect(r).toMatchObject({ ok: false });
    c.clear();
    await c.send({ t: 'mission_accept', offerId: second.offerId });
    expect(lastEvent(c).event).toBe('rejected');
    expect(c.account.activeMission!.type).toBe('visit_location');
  });

  it('abandon clears the mission (event abandoned) and a new offer can be created and accepted straight away', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    await start(c, delivery('bakery', 'cafe'));
    c.clear();
    await c.send({ t: 'mission_abandon' });
    expect(lastEvent(c)).toMatchObject({ event: 'abandoned', state: null });
    expect(c.account.activeMission).toBeNull();
    // abandoning is not a completion: no cooldown, no reward
    expect(c.account.coins).toBe(STARTING_COINS);
    await start(c, delivery('bakery', 'cafe', { title: 'Bread delivery again' }));
    expect(c.account.activeMission!.title).toBe('Bread delivery again');
    // abandon with nothing active is a rejected no-op
    await c.send({ t: 'mission_abandon' });
    c.clear();
    await c.send({ t: 'mission_abandon' });
    expect(lastEvent(c).event).toBe('rejected');
  });
});

describe('expiry', () => {
  it('missions expire at max(estimate * factor, floor) and are cleared by the sweep', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const offer = await start(c, visit('arcade'));
    const state = lastEvent(c).state!;
    const deadline = Math.max(offer.estimatedMinutes * 60_000 * MISSION_LIMITS.deadlineFactor, MISSION_LIMITS.deadlineFloorMs);
    expect(state.expiresAt - state.startedAt).toBe(deadline);
    h.clock.advance(deadline - 1000);
    h.srv.game.housekeeping();
    expect(c.account.activeMission).not.toBeNull();
    h.clock.advance(2000);
    c.clear();
    h.srv.game.housekeeping();
    expect(lastEvent(c)).toMatchObject({ event: 'expired', state: null });
    expect(c.account.activeMission).toBeNull();
    // arriving too late pays nothing
    h.clock.advance(100);
    c.teleport(loc('arcade').x - 1, loc('arcade').z);
    await c.moveTo(loc('arcade').x, loc('arcade').z);
    expect(c.account.coins).toBe(STARTING_COINS);
  });

  it('an interact after the deadline reports expiry instead of completing', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    await start(c, delivery('bakery', 'cafe'));
    c.teleport(loc('bakery').x, loc('bakery').z);
    h.clock.advance(MISSION_LIMITS.deadlineFloorMs * 10);
    c.clear();
    await c.send({ t: 'interact', target: 'bakery' });
    expect(c.of('mission').map((m) => m.event)).toEqual(['expired']);
    expect(c.account.activeMission).toBeNull();
  });

  it('a mission that expired while offline is cleared on reconnect', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    await start(c, visit('arcade'));
    h.srv.game.disconnect(c.session);
    h.clock.advance(MISSION_LIMITS.deadlineFloorMs * 10);
    const again = await h.join('alice', 'a@example.com');
    expect(again.last('welcome')!.mission).toBeNull();
    expect(again.of('mission').map((m) => m.event)).toEqual(['expired']);
    expect(again.account.activeMission).toBeNull();
  });
});

describe('cooldown and daily cap', () => {
  async function finishVisit(c: TestClient, to = 'arcade') {
    await start(c, visit(to));
    c.teleport(loc(to).x, loc(to).z);
    h.clock.advance(100);
    await c.moveTo(loc(to).x, loc(to).z + 0.05);
    expect(lastEvent(c).event).toBe('completed');
  }

  it('per-type cooldown after a completion; other types are unaffected', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    await finishVisit(c);
    c.teleport(SPAWN.x, SPAWN.z);
    const blocked = h.srv.missions.createOffer(c.id, visit('library'));
    expect(blocked).toMatchObject({ ok: false });
    expect((blocked as { error: string }).error).toMatch(/seconds/);
    expect(h.srv.missions.createOffer(c.id, delivery('bakery', 'cafe')).ok).toBe(true);
    h.clock.advance(MISSION_LIMITS.cooldownMsPerType + 1);
    expect(h.srv.missions.createOffer(c.id, visit('library')).ok).toBe(true);
  });

  it('refuses new offers once the daily reward cap is reached and resets on the next UTC day', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    c.account.dailyRewards = { day: dayKey(h.clock()), coins: MISSION_LIMITS.dailyRewardCoinCap };
    const r = h.srv.missions.createOffer(c.id, visit());
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/daily/i);
    h.clock.advance(24 * 3600_000);
    expect(h.srv.missions.createOffer(c.id, visit()).ok).toBe(true);
  });

  it('clips the payout to the remaining daily allowance and says so', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    c.account.dailyRewards = { day: dayKey(h.clock()), coins: MISSION_LIMITS.dailyRewardCoinCap - 6 };
    await finishVisit(c);
    expect(lastEvent(c).reward).toMatchObject({ coins: 6, mock: true });
    expect(lastEvent(c).reward!.label).toMatch(/6 coins/);
    expect(lastEvent(c).reward!.label).toMatch(/daily limit/i);
    expect(c.account.coins).toBe(STARTING_COINS + 6);
    expect(c.account.dailyRewards.coins).toBe(MISSION_LIMITS.dailyRewardCoinCap);
  });

  it('cap is also enforced when the cap was reached while a mission was already active', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    await start(c, visit('arcade'));
    c.account.dailyRewards = { day: dayKey(h.clock()), coins: MISSION_LIMITS.dailyRewardCoinCap };
    c.teleport(loc('arcade').x, loc('arcade').z);
    h.clock.advance(100);
    await c.moveTo(loc('arcade').x, loc('arcade').z + 0.05);
    expect(lastEvent(c).event).toBe('completed');
    expect(lastEvent(c).reward!.coins).toBeUndefined();
    expect(c.account.coins).toBe(STARTING_COINS);
  });

  it('the accumulated daily total across many completions never exceeds the cap', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    const spots = ['ts_path', 'ts_bench'];
    for (let round = 0; round < 8; round++) {
      h.clock.advance(MISSION_LIMITS.cooldownMsPerType + 1);
      c.teleport(SPAWN.x, SPAWN.z);
      const offer = h.srv.missions.createOffer(c.id, hunt(spots));
      if (!offer.ok) break;
      c.clear();
      await c.send({ t: 'mission_accept', offerId: offer.offer.offerId });
      for (const sp of spots) {
        c.teleport(loc(sp).x, loc(sp).z);
        await c.send({ t: 'interact', target: sp });
      }
    }
    expect(c.account.coins - STARTING_COINS).toBeLessThanOrEqual(MISSION_LIMITS.dailyRewardCoinCap);
    expect(c.account.coins - STARTING_COINS).toBe(MISSION_LIMITS.dailyRewardCoinCap);
  });
});

describe('persistence of mission state', () => {
  it('an active mission survives a reconnect with its progress', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    await start(c, delivery('bakery', 'cafe'));
    c.teleport(loc('bakery').x, loc('bakery').z);
    await c.send({ t: 'interact', target: 'bakery' });
    h.srv.game.disconnect(c.session);
    const again = await h.join('alice', 'a@example.com');
    const m = again.last('welcome')!.mission!;
    expect(m.type).toBe('delivery');
    expect(m.current).toBe(1);
    expect(m.objectives[0].done).toBe(true);
    // and it can still be finished
    again.teleport(loc('cafe').x, loc('cafe').z);
    again.clear();
    await again.send({ t: 'interact', target: 'cafe' });
    expect(again.last('mission')!.event).toBe('completed');
  });

  it('survives a server restart (db reload), including claims and cooldowns', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'a@example.com');
    await start(c, delivery('bakery', 'cafe'));
    const id = c.account.activeMission!.id;
    await h.srv.db.flush();
    const { createServer } = await import('../src/server');
    const { silentLogger } = await import('../src/log');
    const srv2 = createServer({ dataDir: h.dir, now: h.clock, logger: silentLogger, timers: false });
    const acc = srv2.db.getAccount(c.id)!;
    expect(acc.activeMission?.id).toBe(id);
    expect(srv2.missions.stateView(c.id)).toMatchObject({ id, type: 'delivery' });
    await srv2.stop();
  });
});
