import { box, circle, type Collider } from './collision';
import { WORLD_BOUNDS } from './constants';

/** The town. All coordinates are metres in the x/z plane (y is up, north is -z). Shared by client and server. */

export interface Building {
  id: string;
  name: string;
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  color: string;
  roof: string;
  /** which side of the building the door/front faces */
  door: 'N' | 'S';
  kind: 'shop' | 'cafe' | 'bakery' | 'apartments' | 'hall' | 'library' | 'post' | 'arcade';
}

export const ROAD = { minZ: -5, maxZ: 5, sidewalk: 3.5 } as const; // main E-W street
export const CROSS_ROAD = { minX: -5, maxX: 5, minZ: -30, maxZ: -5 } as const; // N-S street into the park

export const BUILDINGS: Building[] = [
  { id: 'apartments_west', name: 'Maple Apartments', x: -48, z: -16, w: 16, d: 12, h: 18, color: '#b5651d', roof: '#5d4037', door: 'S', kind: 'apartments' },
  { id: 'bakery', name: 'Golden Crust Bakery', x: -30, z: -16, w: 14, d: 12, h: 8, color: '#e8c58a', roof: '#a1452c', door: 'S', kind: 'bakery' },
  { id: 'market', name: 'Pixel Market', x: 20, z: -17, w: 16, d: 10, h: 9, color: '#4fa3a5', roof: '#2f4858', door: 'S', kind: 'shop' },
  { id: 'arcade', name: 'Neon Arcade', x: 42, z: -16, w: 14, d: 12, h: 10, color: '#5b4b8a', roof: '#2b2350', door: 'S', kind: 'arcade' },
  { id: 'apartments_east', name: 'Harbor Flats', x: 55, z: -16, w: 8, d: 12, h: 14, color: '#9aa7b1', roof: '#4a5560', door: 'S', kind: 'apartments' },
  { id: 'cafe', name: 'Bean There Café', x: -42, z: 16, w: 14, d: 12, h: 7, color: '#c98f6b', roof: '#6d4c41', door: 'N', kind: 'cafe' },
  { id: 'town_hall', name: 'Town Hall', x: -20, z: 16, w: 18, d: 12, h: 14, color: '#d9d4c7', roof: '#7b2d26', door: 'N', kind: 'hall' },
  { id: 'library', name: 'Town Library', x: 22, z: 16, w: 16, d: 12, h: 11, color: '#8c5a5a', roof: '#4e342e', door: 'N', kind: 'library' },
  { id: 'post_office', name: 'Post Office', x: 42, z: 16, w: 12, d: 12, h: 7, color: '#d94f4f', roof: '#7f2a2a', door: 'N', kind: 'post' },
];

export interface Prop {
  kind: 'tree' | 'lamp' | 'bench' | 'fountain' | 'pond' | 'gazebo' | 'swing' | 'slide' | 'sandbox';
  x: number;
  z: number;
  rot?: number; // radians around y
  scale?: number;
}

export const FOUNTAIN = { x: 1.5, z: 28, r: 4 } as const;
export const POND = { x: -18, z: -44, r: 6 } as const;
export const GAZEBO = { x: 12, z: -44, half: 2 } as const;
export const PLAYGROUND = { x: 42, z: 42 } as const;

/** Shop counter (open-air kiosk in front of Pixel Market). */
export const SHOP_COUNTER = { x: 20, z: -9.8, w: 5, d: 0.8 } as const;
export const SHOPKEEPER_POS = { x: 20, z: -11 } as const;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function doorX(side: 'N' | 'S'): number[] {
  return BUILDINGS.filter((b) => b.door === side).map((b) => b.x);
}

function buildProps(): Prop[] {
  const props: Prop[] = [];
  // street lamps on both curbs
  for (let x = -56; x <= 56; x += 14) {
    props.push({ kind: 'lamp', x, z: -5.4, rot: Math.PI });
    props.push({ kind: 'lamp', x, z: 5.4, rot: 0 });
  }
  // sidewalk trees (skip doors and the cross street / plaza openings)
  for (let x = -49; x <= 49; x += 14) {
    if (Math.abs(x) >= 10) {
      if (!doorX('S').some((dx) => Math.abs(dx - x) < 4)) props.push({ kind: 'tree', x, z: -7.4, scale: 0.8 });
      if (!doorX('N').some((dx) => Math.abs(dx - x) < 4)) props.push({ kind: 'tree', x, z: 7.4, scale: 0.8 });
    }
  }
  // plaza & park furniture
  props.push({ kind: 'fountain', x: FOUNTAIN.x, z: FOUNTAIN.z });
  props.push({ kind: 'bench', x: -5, z: 17, rot: 0 }, { kind: 'bench', x: 8, z: 17, rot: 0 });
  props.push({ kind: 'bench', x: -5, z: 38, rot: Math.PI }, { kind: 'bench', x: 8, z: 38, rot: Math.PI });
  props.push({ kind: 'bench', x: 3.6, z: -40, rot: Math.PI / 2 }, { kind: 'bench', x: -3.6, z: -50, rot: -Math.PI / 2 });
  props.push({ kind: 'pond', x: POND.x, z: POND.z });
  props.push({ kind: 'gazebo', x: GAZEBO.x, z: GAZEBO.z });
  props.push({ kind: 'swing', x: PLAYGROUND.x - 4, z: PLAYGROUND.z + 2 });
  props.push({ kind: 'slide', x: PLAYGROUND.x + 5, z: PLAYGROUND.z + 2 });
  props.push({ kind: 'sandbox', x: PLAYGROUND.x, z: PLAYGROUND.z - 3 });

  const rng = mulberry32(1337);
  const placed: { x: number; z: number }[] = props.filter((p) => p.kind === 'tree').map((p) => ({ x: p.x, z: p.z }));
  const tryScatter = (count: number, minX: number, maxX: number, minZ: number, maxZ: number, reject: (x: number, z: number) => boolean) => {
    let made = 0;
    let guard = 0;
    while (made < count && guard++ < 4000) {
      const x = minX + rng() * (maxX - minX);
      const z = minZ + rng() * (maxZ - minZ);
      if (reject(x, z)) continue;
      if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < 3.4)) continue;
      placed.push({ x, z });
      props.push({ kind: 'tree', x, z, scale: 0.8 + rng() * 0.7 });
      made++;
    }
  };
  // park (north)
  tryScatter(46, -55, 55, -56, -31, (x, z) => Math.hypot(x - POND.x, z - POND.z) < 9 || Math.hypot(x - GAZEBO.x, z - GAZEBO.z) < 6 || Math.abs(x) < 5);
  // north of buildings (behind the building row)
  tryScatter(14, -56, 56, -30, -24, (x) => Math.abs(x) < 7);
  // south areas
  tryScatter(16, 28, 56, 26, 56, (x, z) => Math.hypot(x - PLAYGROUND.x, z - PLAYGROUND.z) < 10);
  tryScatter(18, -56, -14, 26, 56, () => false);
  tryScatter(6, 14, 28, 44, 56, () => false);
  return props;
}

export const PROPS: Prop[] = buildProps();

/** Decorative trees outside the walkable bounds (no collision). */
export const PERIMETER_TREES: { x: number; z: number; scale: number }[] = (() => {
  const rng = mulberry32(99);
  const out: { x: number; z: number; scale: number }[] = [];
  for (let i = 0; i < 220; i++) {
    const a = rng() * Math.PI * 2;
    const r = 66 + rng() * 26;
    out.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, scale: 1 + rng() * 1.2 });
  }
  return out;
})();

export const COLLIDERS: Collider[] = (() => {
  const c: Collider[] = [];
  for (const b of BUILDINGS) c.push(box(b.x, b.z, b.w, b.d));
  // shop counter and its side walls
  c.push(box(SHOP_COUNTER.x, SHOP_COUNTER.z, SHOP_COUNTER.w, SHOP_COUNTER.d));
  c.push(box(SHOP_COUNTER.x - SHOP_COUNTER.w / 2 - 0.1, -10.8, 0.2, 2.6));
  c.push(box(SHOP_COUNTER.x + SHOP_COUNTER.w / 2 + 0.1, -10.8, 0.2, 2.6));
  for (const p of PROPS) {
    switch (p.kind) {
      case 'tree': c.push(circle(p.x, p.z, 0.35)); break;
      case 'lamp': c.push(circle(p.x, p.z, 0.25)); break;
      case 'bench': {
        const vertical = Math.abs(Math.sin(p.rot ?? 0)) > 0.7;
        c.push(vertical ? box(p.x, p.z, 0.7, 1.9) : box(p.x, p.z, 1.9, 0.7));
        break;
      }
      case 'fountain': c.push(circle(p.x, p.z, FOUNTAIN.r + 0.2)); break;
      case 'pond': c.push(circle(p.x, p.z, POND.r)); break;
      case 'gazebo':
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) c.push(circle(p.x + sx * GAZEBO.half, p.z + sz * GAZEBO.half, 0.3));
        break;
      case 'swing': c.push(box(p.x, p.z, 4, 0.7)); break;
      case 'slide': c.push(box(p.x, p.z, 1.2, 3.2)); break;
      default: break;
    }
  }
  return c;
})();

export type LocationKind = 'shop' | 'building' | 'landmark' | 'park';

export interface GameLocation {
  id: string;
  name: string;
  description: string;
  /** point a player can stand on to be "at" the location */
  x: number;
  z: number;
  kind: LocationKind;
  aliases: string[];
  /** hidden locations (treasure spots) are never offered to players by name */
  hidden?: boolean;
}

export const LOCATIONS: GameLocation[] = [
  { id: 'plaza', name: 'Town Plaza', description: 'The central square where everyone arrives.', x: 1.5, z: 14, kind: 'landmark', aliases: ['plaza', 'square', 'spawn', 'start'] },
  { id: 'fountain', name: 'Plaza Fountain', description: 'A stone fountain in the south plaza.', x: 1.5, z: 22.5, kind: 'landmark', aliases: ['fountain'] },
  { id: 'shop', name: 'Pixel Market', description: 'The general store: cosmetics, snacks and collectibles.', x: 20, z: -8, kind: 'shop', aliases: ['shop', 'store', 'market', 'pixel market', 'buy', 'kiosk'] },
  { id: 'bakery', name: 'Golden Crust Bakery', description: 'Fresh bread and pastries. Delivery pickups happen here.', x: -30, z: -8, kind: 'building', aliases: ['bakery', 'bread', 'golden crust'] },
  { id: 'arcade', name: 'Neon Arcade', description: 'Glowing cabinets and retro games.', x: 42, z: -8, kind: 'building', aliases: ['arcade', 'games', 'neon'] },
  { id: 'cafe', name: 'Bean There Café', description: 'Coffee and a quiet place to chat.', x: -42, z: 8, kind: 'building', aliases: ['cafe', 'café', 'coffee', 'bean there'] },
  { id: 'town_hall', name: 'Town Hall', description: 'The clock-tower building on the south side.', x: -20, z: 8, kind: 'building', aliases: ['town hall', 'hall', 'clock tower', 'city hall'] },
  { id: 'library', name: 'Town Library', description: 'Quiet shelves and old maps.', x: 22, z: 8, kind: 'building', aliases: ['library', 'books'] },
  { id: 'post_office', name: 'Post Office', description: 'Parcels and letters. Delivery pickups happen here.', x: 42, z: 8, kind: 'building', aliases: ['post office', 'post', 'mail', 'parcel'] },
  { id: 'gazebo', name: 'Park Gazebo', description: 'A wooden gazebo in the north park.', x: 12, z: -44, kind: 'park', aliases: ['gazebo', 'park', 'pavilion'] },
  { id: 'pond', name: 'Lily Pond', description: 'A calm pond with lily pads in the north park.', x: -18, z: -36.2, kind: 'park', aliases: ['pond', 'lake', 'lily pond', 'water'] },
  { id: 'playground', name: 'Playground', description: 'Swings and a slide in the south-east corner.', x: 42, z: 33.5, kind: 'park', aliases: ['playground', 'swings', 'slide', 'kids'] },
  // hidden treasure-hunt spots
  { id: 'ts_oak', name: 'Old Oak Clearing', description: '', x: -28, z: -52, kind: 'park', aliases: [], hidden: true },
  { id: 'ts_bridge', name: 'Willow Corner', description: '', x: 24, z: -52, kind: 'park', aliases: [], hidden: true },
  { id: 'ts_path', name: 'Park Path', description: '', x: 0, z: -34, kind: 'park', aliases: [], hidden: true },
  { id: 'ts_bench', name: 'Quiet Bench', description: '', x: 6, z: -48, kind: 'park', aliases: [], hidden: true },
  { id: 'ts_lamp', name: 'Lantern Row', description: '', x: -38, z: 3, kind: 'landmark', aliases: [], hidden: true },
  { id: 'ts_plaza', name: 'South Plaza Edge', description: '', x: -8, z: 40, kind: 'landmark', aliases: [], hidden: true },
  { id: 'ts_garden', name: 'Garden Hedge', description: '', x: 30, z: 52, kind: 'park', aliases: [], hidden: true },
  { id: 'ts_slide', name: 'Slide Hill', description: '', x: 50, z: 52, kind: 'park', aliases: [], hidden: true },
];

export const SPAWN = { x: 1.5, z: 14, ry: Math.PI } as const;

export const locationById = (id: string): GameLocation | undefined => LOCATIONS.find((l) => l.id === id);
export const publicLocations = (): GameLocation[] => LOCATIONS.filter((l) => !l.hidden);
export const TREASURE_SPOT_IDS = LOCATIONS.filter((l) => l.hidden).map((l) => l.id);
/** Locations where parcels can be collected. */
export const PICKUP_LOCATION_IDS = ['bakery', 'post_office'] as const;
/** Locations that can be a delivery destination. */
export const DROPOFF_LOCATION_IDS = ['cafe', 'town_hall', 'library', 'arcade', 'shop', 'gazebo', 'playground', 'fountain'] as const;

export { WORLD_BOUNDS };
