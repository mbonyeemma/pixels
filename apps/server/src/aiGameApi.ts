import {
  LOCATIONS,
  REWARDS,
  REWARD_FOR_TYPE,
  SHOP_COUNTER,
  locationById,
  shopItems,
  toShopItemView,
  walkDistance,
  type AiAction,
  type AiGameApi,
  type GameLocation,
} from '@pixels/shared';
import type { Database } from './db';
import type { Game } from './game';
import type { MissionEngine } from './missions';
import type { Shop } from './shop';
import { dist2d, round } from './util';

export interface AiApiDeps {
  db: Database;
  game: Pick<Game, 'getPlayerPosition' | 'onlineSessions' | 'playerCount'>;
  missions: Pick<MissionEngine, 'createOffer' | 'stateView'>;
  shop: Pick<Shop, 'checkPurchasable'>;
}

const NEARBY_RADIUS = 12;

const publicLocations = (): GameLocation[] => LOCATIONS.filter((l) => !l.hidden);

/** Lower-case, strip accents and punctuation so "Café!" matches "cafe". */
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Names a location answers to, normalised: id (with underscores as spaces), display name and aliases. */
function namesOf(l: GameLocation): string[] {
  return [...new Set([l.id.replace(/_/g, ' '), l.name, ...l.aliases].map(norm).filter(Boolean))];
}

/** Fuzzy lookup of a public location: exact, then prefix, then substring, then "the query mentions it". */
export function matchLocation(query: string): GameLocation | null {
  const q = norm(query);
  if (q.length < 3) return null;
  const locs = publicLocations();
  const named = locs.map((l) => ({ l, names: namesOf(l) }));

  const exact = named.find((x) => x.names.includes(q));
  if (exact) return exact.l;
  const prefix = named.find((x) => x.names.some((n) => n.startsWith(q)));
  if (prefix) return prefix.l;
  const contains = named.find((x) => x.names.some((n) => n.includes(q)));
  if (contains) return contains.l;
  // "take me to the golden crust bakery please" -> the longest known name mentioned as whole words
  let best: { l: GameLocation; len: number } | null = null;
  const padded = ` ${q} `;
  for (const x of named) {
    for (const n of x.names) {
      if (n.length >= 3 && padded.includes(` ${n} `) && (!best || n.length > best.len)) best = { l: x.l, len: n.length };
    }
  }
  return best ? best.l : null;
}

/** Build the capability object the AI layer is allowed to use for one player. Everything is validated server-side. */
export function createAiGameApi(deps: AiApiDeps, accountId: string): AiGameApi {
  const pos = () => deps.game.getPlayerPosition(accountId);
  const account = () => deps.db.getAccount(accountId);
  const distTo = (l: { x: number; z: number }) => {
    const p = pos();
    return round(dist2d(p.x, p.z, l.x, l.z), 1);
  };

  return {
    getPlayerContext() {
      const a = account();
      const p = pos();
      const sorted = publicLocations()
        .map((l) => ({ id: l.id, name: l.name, distance: round(dist2d(p.x, p.z, l.x, l.z), 1) }))
        .sort((x, y) => x.distance - y.distance);
      const nearby = sorted.filter((l) => l.distance <= NEARBY_RADIUS);
      const counterDist = round(dist2d(p.x, p.z, SHOP_COUNTER.x, SHOP_COUNTER.z), 1);
      if (counterDist <= NEARBY_RADIUS) nearby.push({ id: 'shop_counter', name: 'Shop counter', distance: counterDist });
      nearby.sort((x, y) => x.distance - y.distance);
      const state = deps.missions.stateView(accountId);
      const current = state ? state.objectives[state.current] : undefined;
      return {
        displayName: a?.displayName ?? 'Player',
        x: round(p.x, 1),
        z: round(p.z, 1),
        coins: a?.coins ?? 0,
        nearestLocation: sorted[0] ?? null,
        nearbyInteractables: nearby,
        activeMission: state ? { title: state.title, type: state.type, currentObjective: current?.label ?? 'Finish up' } : null,
        playersOnline: deps.game.playerCount,
      };
    },

    listLocations() {
      return publicLocations().map((l) => ({ id: l.id, name: l.name, description: l.description, distance: distTo(l) }));
    },

    findLocation(query) {
      const l = matchLocation(query);
      return l ? { id: l.id, name: l.name, description: l.description, x: l.x, z: l.z, distance: distTo(l) } : null;
    },

    navigateTo(locationId) {
      const l = locationById(locationId);
      if (!l || l.hidden) return { ok: false, error: `I do not know a place called "${locationId}".` };
      const p = pos();
      const d = walkDistance(p, l);
      if (!Number.isFinite(d)) return { ok: false, error: `${l.name} cannot be reached on foot from here.` };
      const action: Extract<AiAction, { type: 'navigate' }> = {
        type: 'navigate',
        locationId: l.id,
        label: l.name,
        x: l.x,
        z: l.z,
        distance: round(d, 1),
      };
      return { ok: true, action };
    },

    openShop() {
      if (!locationById('shop')) return { ok: false, error: 'The shop is closed right now.' };
      return { ok: true, action: { type: 'open_shop' } };
    },

    listShopItems() {
      return shopItems().map(toShopItemView);
    },

    proposePurchase(itemId) {
      const a = account();
      if (!a) return { ok: false, error: 'Unknown player.' };
      const check = deps.shop.checkPurchasable(a, itemId);
      if (!check.ok) return { ok: false, error: check.error };
      return {
        ok: true,
        action: { type: 'purchase_proposal', itemId: check.item.id, name: check.item.name, price: check.item.price, canAfford: a.coins >= check.item.price },
      };
    },

    listAvailableQuests() {
      const label = (type: keyof typeof REWARD_FOR_TYPE) => REWARDS[REWARD_FOR_TYPE[type]].label;
      return [
        {
          type: 'visit_location',
          description: `Walk to a place in town and arrive there. Reward: ${label('visit_location')}. The place must be at least 12 m away.`,
          examples: ['Visit the Neon Arcade', 'Go see the Lily Pond', 'Pay a visit to the Town Library'],
        },
        {
          type: 'delivery',
          description: `Collect a parcel at the Golden Crust Bakery or the Post Office, then deliver it to another place (cafe, town hall, library, arcade, shop, gazebo, playground or fountain). Reward: ${label('delivery')}.`,
          examples: ['Pick up bread at the Bakery and bring it to the Bean There Cafe', 'Collect a parcel at the Post Office and deliver it to the Town Library'],
        },
        {
          type: 'treasure_hunt',
          description: `Find 2 to 4 hidden treasure spots in the order they are revealed (stand close and interact). Reward: ${label('treasure_hunt')}.`,
          examples: ['Treasure hunt through the park', 'Find three hidden spots around town'],
        },
      ];
    },

    createMissionOffer(proposal) {
      return deps.missions.createOffer(accountId, proposal);
    },

    findPlayers() {
      const me = deps.game.getPlayerPosition(accountId);
      return deps.game
        .onlineSessions()
        .filter((s) => s.id !== accountId)
        .map((s) => ({
          name: s.name,
          distance: me.online ? Math.round(dist2d(me.x, me.z, s.x, s.z) / 5) * 5 : null,
        }));
    },
  };
}
