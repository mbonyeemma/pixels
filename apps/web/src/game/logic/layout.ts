import { CROSS_ROAD, ROAD, WORLD_BOUNDS } from '@pixels/shared';

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
  return best * SIDEWALK_H;
}
