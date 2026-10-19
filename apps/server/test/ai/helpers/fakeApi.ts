import {
  LOCATIONS,
  MISSION_LIMITS,
  REWARDS,
  REWARD_FOR_TYPE,
  WALK_SPEED,
  locationById,
  publicLocations,
  shopItems,
  toShopItemView,
  validateMissionProposal,
  walkDistance,
} from '@pixels/shared';
import type { AiAction, AiErrorResponse, AiGameApi, AiResponse, MissionOfferView, MissionProposalInput } from '@pixels/shared';

/**
 * A reusable fake of the AiGameApi built on the REAL shared world, catalogue and mission validator.
 * It records every call so tests can assert exactly what reached the game layer.
 */

export interface FakeApiOptions {
  x?: number;
  z?: number;
  coins?: number;
  displayName?: string;
  activeMission?: { title: string; type: string; currentObjective: string } | null;
  players?: { name: string; distance: number | null }[];
  /** openShop fails when the player is farther than this from the counter (default: always reachable) */
  shopRange?: number;
  /** mission types currently on cooldown */
  cooldownTypes?: string[];
  dailyCapReached?: boolean;
  /** errors returned (in order) by the next createMissionOffer calls, before any real validation */
  rejectNext?: string[];
  /** if set, navigateTo fails with this error */
  navigateError?: string;
}

export interface RecordedCall {
  method: string;
  args: unknown[];
}

export interface FakeApi extends AiGameApi {
  calls: RecordedCall[];
  /** raw proposals received by createMissionOffer */
  proposals: unknown[];
  offers: MissionOfferView[];
  setPosition(x: number, z: number): void;
  setCoins(n: number): void;
  callsTo(method: string): RecordedCall[];
}

const strip = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g'), '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function createFakeApi(opts: FakeApiOptions = {}): FakeApi {
  const state = { x: opts.x ?? 1.5, z: opts.z ?? 14, coins: opts.coins ?? 100 };
  const calls: RecordedCall[] = [];
  const proposals: unknown[] = [];
  const offers: MissionOfferView[] = [];
  const rejectQueue = [...(opts.rejectNext ?? [])];
  const rec = (method: string, ...args: unknown[]) => void calls.push({ method, args });
  const dist = (l: { x: number; z: number }) => Math.hypot(l.x - state.x, l.z - state.z);

  const api: FakeApi = {
    calls,
    proposals,
    offers,
    setPosition(x, z) {
      state.x = x;
      state.z = z;
    },
    setCoins(n) {
      state.coins = n;
    },
    callsTo: (method) => calls.filter((c) => c.method === method),

    getPlayerContext() {
      rec('getPlayerContext');
      const pub = publicLocations()
        .map((l) => ({ id: l.id, name: l.name, distance: dist(l) }))
        .sort((a, b) => a.distance - b.distance);
      return {
        displayName: opts.displayName ?? 'Tester#0001',
        x: state.x,
        z: state.z,
        coins: state.coins,
        nearestLocation: pub[0] ?? null,
        nearbyInteractables: pub.filter((p) => p.distance < 12).slice(0, 4),
        activeMission: opts.activeMission ?? null,
        playersOnline: 1 + (opts.players?.length ?? 0),
      };
    },

    listLocations() {
      rec('listLocations');
      return publicLocations().map((l) => ({ id: l.id, name: l.name, description: l.description, distance: dist(l) }));
    },

    findLocation(query: string) {
      rec('findLocation', query);
      const q = strip(query);
      if (!q) return null;
      const keys = publicLocations().flatMap((l) => [l.id.replace(/_/g, ' '), l.name, ...l.aliases].map((k) => ({ l, k: strip(k) })));
      const exact = keys.find((e) => e.k === q);
      let found = exact?.l;
      if (!found) {
        const contained = keys.filter((e) => e.k.length >= 3 && ` ${q} `.includes(` ${e.k} `)).sort((a, b) => b.k.length - a.k.length)[0];
        found = contained?.l;
      }
      if (!found && q.length >= 3) found = keys.find((e) => ` ${e.k} `.includes(` ${q} `))?.l;
      if (!found) return null;
      return { id: found.id, name: found.name, description: found.description, x: found.x, z: found.z, distance: dist(found) };
    },

    navigateTo(locationId: string) {
      rec('navigateTo', locationId);
      const l = publicLocations().find((p) => p.id === locationId);
      if (!l) return { ok: false, error: `Unknown location "${locationId}".` };
      if (opts.navigateError) return { ok: false, error: opts.navigateError };
      const d = walkDistance({ x: state.x, z: state.z }, l);
      if (!Number.isFinite(d)) return { ok: false, error: 'No walkable path to that place.' };
      return { ok: true, action: { type: 'navigate', locationId: l.id, label: l.name, x: l.x, z: l.z, distance: d } };
    },

    openShop() {
      rec('openShop');
      const shop = locationById('shop')!;
      if (opts.shopRange !== undefined && dist(shop) > opts.shopRange) return { ok: false, error: 'You are too far from the shop. Walk closer first.' };
      return { ok: true, action: { type: 'open_shop' } };
    },

    listShopItems() {
      rec('listShopItems');
      return shopItems().map(toShopItemView);
    },

    proposePurchase(itemId: string) {
      rec('proposePurchase', itemId);
      const item = shopItems().find((i) => i.id === itemId);
      if (!item) return { ok: false, error: 'That item is not for sale.' };
      return { ok: true, action: { type: 'purchase_proposal', itemId: item.id, name: item.name, price: item.price!, canAfford: state.coins >= item.price! } };
    },

    listAvailableQuests() {
      rec('listAvailableQuests');
      return [
        { type: 'visit_location', description: 'Walk to a place in town and look around.', examples: ['Visit the library'] },
        { type: 'delivery', description: 'Carry a parcel from the bakery or post office to another place.', examples: ['Bread run to the cafe'] },
        { type: 'treasure_hunt', description: 'Find 2-4 hidden spots around town.', examples: ['Park treasure hunt'] },
      ];
    },

    createMissionOffer(proposal: MissionProposalInput) {
      rec('createMissionOffer', proposal);
      proposals.push(proposal);
      const injected = rejectQueue.shift();
      if (injected) return { ok: false, error: injected };
      // error texts and the duration estimate mirror the real mission engine (apps/server/src/missions.ts)
      const v = validateMissionProposal(proposal);
      if (!v.ok) return { ok: false, error: v.error };
      const p = v.proposal;
      if (opts.activeMission) return { ok: false, error: 'You already have an active mission. Finish or abandon it before taking another.' };
      if (opts.cooldownTypes?.includes(p.type)) return { ok: false, error: `You just finished a ${p.type.replace('_', ' ')} mission. Try a different kind, or wait 30 seconds.` };
      if (opts.dailyCapReached) return { ok: false, error: 'You have reached the daily mission reward limit. Come back tomorrow.' };
      const stops = (p.type === 'delivery' ? [p.startLocationId, ...p.objectiveLocationIds] : [...p.objectiveLocationIds]).map((id) => locationById(id)!);
      let total = 0;
      let cur = { x: state.x, z: state.z };
      for (const s of stops) {
        const d = walkDistance(cur, s);
        total += Number.isFinite(d) ? d : Math.hypot(s.x - cur.x, s.z - cur.z);
        cur = s;
      }
      if (total < MISSION_LIMITS.minTotalDistance) return { ok: false, error: `That is too close (${Math.round(total)} m). Missions must involve at least ${MISSION_LIMITS.minTotalDistance} m of walking.` };
      if (total > MISSION_LIMITS.maxTotalDistance) return { ok: false, error: `That is too far (${Math.round(total)} m). Missions can cover at most ${MISSION_LIMITS.maxTotalDistance} m of walking.` };
      const reward = REWARDS[p.rewardId];
      const minutes = Math.min(MISSION_LIMITS.maxMinutes, Math.max(MISSION_LIMITS.minMinutes, Math.ceil(total / (WALK_SPEED * 0.8) / 60)));
      const offer: MissionOfferView = {
        offerId: `offer_${offers.length + 1}`,
        title: p.title,
        description: p.description,
        type: p.type,
        estimatedMinutes: minutes,
        objectives: stops.map((s) => `Go to ${s.name}`),
        reward: { label: reward.label, coins: reward.coins, itemId: reward.itemId, mock: true },
        expiresAt: Date.now() + MISSION_LIMITS.offerTtlMs,
      };
      offers.push(offer);
      return { ok: true, offer };
    },

    findPlayers() {
      rec('findPlayers');
      return (opts.players ?? []).map((p) => ({ ...p }));
    },
  };
  return api;
}

/* ------------------------------------------------------------------ small test utilities */

export const isError = (r: AiResponse | AiErrorResponse): r is AiErrorResponse => 'error' in r;

export function expectResponse(r: AiResponse | AiErrorResponse): AiResponse {
  if (isError(r)) throw new Error(`expected an AiResponse, got error ${r.code}: ${r.error}`);
  return r;
}

export const actionOf = <T extends AiAction['type']>(r: AiResponse, type: T): Extract<AiAction, { type: T }> | undefined =>
  r.actions.find((a) => a.type === type) as Extract<AiAction, { type: T }> | undefined;

export const actionTypes = (r: AiResponse): string[] => r.actions.map((a) => a.type);

export const REAL_LOCATION_COUNT = LOCATIONS.filter((l) => !l.hidden).length;
export { REWARD_FOR_TYPE };
