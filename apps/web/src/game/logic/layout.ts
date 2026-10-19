import { BUILDINGS, CROSS_ROAD, POND, ROAD, WORLD_BOUNDS } from '@pixels/shared';

/** Paved/ground layout derived from the shared world data. Pure data shared by the renderer and the height function. */
export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export const SIDEWALK_H = 0.06;
/** distance between the kerb (road edge) and the building row on each side of the main street */
export const FRONT_Z = 10;

export const SIDEWALK_RECTS: Rect[] = [
  // main street, north side (open where the cross street joins)
  { minX: WORLD_BOUNDS.minX, maxX: -CROSS_ROAD.maxX, minZ: -FRONT_Z, maxZ: ROAD.minZ },
  { minX: CROSS_ROAD.maxX, maxX: WORLD_BOUNDS.maxX, minZ: -FRONT_Z, maxZ: ROAD.minZ },
  // main street, south side
  { minX: WORLD_BOUNDS.minX, maxX: WORLD_BOUNDS.maxX, minZ: ROAD.maxZ, maxZ: FRONT_Z },
  // cross street
  { minX: CROSS_ROAD.minX - 3.5, maxX: CROSS_ROAD.minX, minZ: CROSS_ROAD.minZ, maxZ: -FRONT_Z },
  { minX: CROSS_ROAD.maxX, maxX: CROSS_ROAD.maxX + 3.5, minZ: CROSS_ROAD.minZ, maxZ: -FRONT_Z },
];
export const PLAZA_RECT: Rect = { minX: -11, maxX: 14, minZ: FRONT_Z, maxZ: 43 };
export const KIOSK_COURT: Rect = { minX: 12, maxX: 28, minZ: -12, maxZ: -FRONT_Z };
export const PLAYGROUND_RECT: Rect = { minX: 33, maxX: 51, minZ: 35, maxZ: 49 };
export const PARK_PATH_RECT: Rect = { minX: -2.5, maxX: 2.5, minZ: -57, maxZ: CROSS_ROAD.minZ };

export const GAZEBO_PLATFORM: Rect = { minX: 9.6, maxX: 14.4, minZ: -46.4, maxZ: -41.6 };
export const GAZEBO_H = 0.14;
export const RAISED_RECTS: Rect[] = [...SIDEWALK_RECTS, PLAZA_RECT, KIOSK_COURT];

const smooth = (x: number): number => x * x * (3 - 2 * x);

/** Visual ground height (m): sidewalks/plaza sit a few cm above the road. The avatar follows it smoothly. */
export function groundHeight(x: number, z: number): number {
  let best = 0;
  for (const r of RAISED_RECTS) {
    const dx = Math.max(r.minX - x, x - r.maxX);
    const dz = Math.max(r.minZ - z, z - r.maxZ);
    const d = Math.max(dx, dz);
    if (d >= 0.3) continue;
    const k = d <= 0 ? 1 : smooth(1 - d / 0.3);
    if (k > best) best = k;
  }
  let h = best * SIDEWALK_H;
  {
    const r = GAZEBO_PLATFORM;
    const dx = Math.max(r.minX - x, x - r.maxX);
    const dz = Math.max(r.minZ - z, z - r.maxZ);
    const d = Math.max(dx, dz);
    if (d < 0.3) {
      const k = d <= 0 ? 1 : smooth(1 - d / 0.3);
      h = Math.max(h, k * GAZEBO_H);
    }
  }
  return h;
}

const inRect = (r: Rect, x: number, z: number, m: number): boolean => x > r.minX - m && x < r.maxX + m && z > r.minZ - m && z < r.maxZ + m;

/** True when (x,z) is plain grass (not road, paving, building, pond, path or playground), with `margin` clearance. */
export function isOpenGrass(x: number, z: number, margin = 0.5): boolean {
  if (Math.abs(x) > WORLD_BOUNDS.maxX - 0.8 || Math.abs(z) > WORLD_BOUNDS.maxZ - 0.8) return false;
  if (z > ROAD.minZ - margin && z < ROAD.maxZ + margin) return false;
  if (x > CROSS_ROAD.minX - 3.5 - margin && x < CROSS_ROAD.maxX + 3.5 + margin && z > CROSS_ROAD.minZ - margin && z < ROAD.minZ) return false;
  for (const r of RAISED_RECTS) if (inRect(r, x, z, margin)) return false;
  if (inRect(PLAYGROUND_RECT, x, z, margin)) return false;
  if (inRect(PARK_PATH_RECT, x, z, margin + 0.4)) return false;
  if (x > -13 && x < 15 && z > -47.5 && z < -40.5) return false; // branch paths + gazebo apron
  if (Math.hypot(x - POND.x, z - POND.z) < POND.r + 1.8 + margin) return false;
  for (const b of BUILDINGS) if (Math.abs(x - b.x) < b.w / 2 + margin + 0.2 && Math.abs(z - b.z) < b.d / 2 + margin + 0.2) return false;
  return true;
}
