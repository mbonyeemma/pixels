import { DROPOFF_LOCATION_IDS, PICKUP_LOCATION_IDS, TREASURE_SPOT_IDS, locationById } from '@pixels/shared';
import type { MissionProposalInput, MissionType } from '@pixels/shared';
import type { LocationHit, LocationRow, PlayerCtx } from '../tools';
import type { MissionTheme } from './rules-nlu';

/**
 * Mission suggestions for the offline engine. Picks a template and locations near the player; titles and
 * descriptions are friendly text. It never sets rewards: the server's validator chooses them.
 */

export interface MissionWish {
  type?: MissionType;
  theme: MissionTheme;
  minutes?: number;
  target: LocationHit | null;
}

export interface MissionEnv {
  ctx: PlayerCtx;
  locations: LocationRow[];
  rng: () => number;
}

export interface BuildOptions {
  /** location ids the previous attempt used; prefer others */
  avoid?: string[];
  /** prefer farther places (used after a "too close" rejection) */
  far?: boolean;
  /** prefer nearer places (used after a "too far" rejection) */
  near?: boolean;
}

/** deterministic PRNG (mulberry32) */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALL: MissionType[] = ['visit_location', 'delivery', 'treasure_hunt'];

export function missionOrder(wish: MissionWish, rng: () => number): MissionType[] {
  let base: MissionType[];
  switch (wish.theme) {
    case 'bored':
      base = ['treasure_hunt', 'visit_location', 'delivery'];
      break;
    case 'earn':
      base = ['delivery', 'treasure_hunt', 'visit_location'];
      break;
    case 'beginner':
      base = ['visit_location', 'delivery', 'treasure_hunt'];
      break;
    default: {
      const shift = Math.floor(rng() * 3);
      const rot: MissionType[] = ['delivery', 'treasure_hunt', 'visit_location'];
      base = [...rot.slice(shift), ...rot.slice(0, shift)];
    }
  }
  if (!wish.type) return base;
  return [wish.type, ...base.filter((t) => t !== wish.type), ...ALL.filter((t) => !base.includes(t) && t !== wish.type)];
}

const pick = <T>(arr: T[], rng: () => number): T => arr[Math.floor(rng() * arr.length) % arr.length];
const coord = (id: string) => {
  const l = locationById(id);
  return l ? { x: l.x, z: l.z } : null;
};
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function startId(env: MissionEnv): string {
  const near = env.ctx.nearestLocation?.id;
  return near && env.locations.some((l) => l.id === near) ? near : 'plaza';
}

export function buildProposal(type: MissionType, wish: MissionWish, env: MissionEnv, opts: BuildOptions = {}): MissionProposalInput | null {
  switch (type) {
    case 'visit_location':
      return buildVisit(wish, env, opts);
    case 'delivery':
      return buildDelivery(wish, env, opts);
    case 'treasure_hunt':
      return buildTreasure(wish, env, opts);
  }
}

function buildVisit(wish: MissionWish, env: MissionEnv, opts: BuildOptions): MissionProposalInput | null {
  const avoid = new Set(opts.avoid ?? []);
  const ok = (l: LocationRow, minD: number) => l.id !== 'plaza' && !locationById(l.id)?.hidden && l.distance >= minD && !avoid.has(l.id);
  let pickLoc: LocationRow | undefined;
  if (wish.target && !avoid.has(wish.target.id)) pickLoc = env.locations.find((l) => l.id === wish.target?.id && ok(l, 8));
  if (!pickLoc) {
    for (const minD of [15, 10, 0]) {
      const pool = env.locations.filter((l) => ok(l, minD)).sort((a, b) => a.distance - b.distance);
      if (pool.length) {
        pickLoc = opts.far
          ? pool[Math.min(pool.length - 1, 3 + Math.floor(env.rng() * 2))]
          : opts.near
            ? pool[0]
            : pool[Math.floor(env.rng() * Math.min(3, pool.length))];
        break;
      }
    }
  }
  if (!pickLoc) return null;
  const name = pickLoc.name;
  const title = pick([`Stroll to ${name}`, `A visit to ${name}`, `Say hello to ${name}`], env.rng);
  const desc = `Walk over to ${name} and take a look around. ${pickLoc.description}`.trim();
  return {
    title: title.slice(0, 60),
    description: desc.slice(0, 280),
    type: 'visit_location',
    startLocationId: startId(env),
    objectiveLocationIds: [pickLoc.id],
    estimatedMinutes: clamp(Math.round(pickLoc.distance / 120) + 1, 1, 5),
  };
}

function buildDelivery(wish: MissionWish, env: MissionEnv, opts: BuildOptions): MissionProposalInput | null {
  const publicIds = new Set(env.locations.map((l) => l.id));
  const byDist = (id: string) => env.locations.find((l) => l.id === id)?.distance ?? Infinity;
  const pickups = (PICKUP_LOCATION_IDS as readonly string[]).filter((id) => publicIds.has(id)).sort((a, b) => byDist(a) - byDist(b));
  if (!pickups.length) return null;
  const start = opts.avoid?.includes(pickups[0]) && pickups[1] ? pickups[1] : pickups[0];
  const sc = coord(start);
  if (!sc) return null;
  const target = opts.far ? 110 : opts.near ? 30 : wish.minutes ? clamp(wish.minutes * 25, 30, 160) : 55;
  const avoid = new Set(opts.avoid ?? []);
  const drops = (DROPOFF_LOCATION_IDS as readonly string[])
    .filter((id) => publicIds.has(id) && id !== start && !avoid.has(id))
    .map((id) => ({ id, d: coord(id) ? dist(sc, coord(id)!) : Infinity }))
    .filter((x) => Number.isFinite(x.d) && x.d >= 12)
    .sort((a, b) => Math.abs(a.d - target) - Math.abs(b.d - target));
  if (!drops.length) return null;
  const chosen = drops[Math.floor(env.rng() * Math.min(2, drops.length))];
  const startName = env.locations.find((l) => l.id === start)?.name ?? start;
  const dropName = env.locations.find((l) => l.id === chosen.id)?.name ?? chosen.id;
  const kind = start === 'bakery' ? 'Fresh bread' : 'Parcel';
  const total = byDist(start) + chosen.d;
  return {
    title: `${kind} run to ${dropName}`.slice(0, 60),
    description: `Pick up an order at ${startName}, then carry it on foot to ${dropName}. Take the scenic route if you like.`.slice(0, 280),
    type: 'delivery',
    startLocationId: start,
    objectiveLocationIds: [chosen.id],
    estimatedMinutes: clamp(Math.round(total / 120) + 1, 1, 8),
  };
}

function buildTreasure(wish: MissionWish, env: MissionEnv, opts: BuildOptions): MissionProposalInput | null {
  const pos = { x: env.ctx.x, z: env.ctx.z };
  const avoid = new Set(opts.avoid ?? []);
  let spots = TREASURE_SPOT_IDS.map((id) => ({ id, c: coord(id) }))
    .filter((s): s is { id: string; c: { x: number; z: number } } => !!s.c)
    .sort((a, b) => dist(pos, a.c) - dist(pos, b.c));
  if (spots.length < 2) return null;
  const preferred = spots.filter((s) => !avoid.has(s.id));
  if (preferred.length >= 2) spots = preferred;
  let k = wish.minutes ? (wish.minutes >= 5 ? 4 : wish.minutes >= 3 ? 3 : 2) : 3;
  if (opts.near) k = 2;
  k = Math.min(k, spots.length);
  const pool = opts.far ? spots.slice(Math.min(2, spots.length - k)) : opts.near ? spots.slice(0, k) : spots.slice(0, Math.min(spots.length, k + 2));
  // choose k from the pool pseudo-randomly, then order them as a short walking route
  const chosen = [...pool];
  for (let i = chosen.length - 1; i > 0; i--) {
    const j = Math.floor(env.rng() * (i + 1));
    [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
  }
  let route = chosen.slice(0, k);
  const ordered: typeof route = [];
  let cur = pos;
  while (route.length) {
    route.sort((a, b) => dist(cur, a.c) - dist(cur, b.c));
    const next = route.shift()!;
    ordered.push(next);
    cur = next.c;
  }
  route = ordered;
  const pathLen = () => route.reduce((acc, s, i) => acc + dist(i === 0 ? pos : route[i - 1].c, s.c), 0);
  while (route.length > 2 && pathLen() > 360) route.pop();
  const total = pathLen();
  const n = route.length;
  const title = pick(['Secrets of the Town', 'The Great Pixel Treasure Hunt', 'Clues Around Town', 'Hidden Spots Hunt'], env.rng);
  return {
    title,
    description: `Search ${n} hidden spots scattered around town. Follow each clue on foot and uncover the treasure!`,
    type: 'treasure_hunt',
    startLocationId: startId(env),
    objectiveLocationIds: route.map((s) => s.id),
    estimatedMinutes: wish.minutes ?? clamp(Math.round(total / 110) + n, 2, 15),
  };
}
