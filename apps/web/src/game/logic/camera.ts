export const PITCH_MIN = 0.05;
export const PITCH_MAX = 1.32;
export const DIST_MIN = 3;
export const DIST_MAX = 12;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clampPitch = (p: number): number => clamp(p, PITCH_MIN, PITCH_MAX);
export const clampDist = (d: number): number => clamp(d, DIST_MIN, DIST_MAX);

/**
 * Unit vector from the target to the camera for an orbit camera.
 * yaw=0 puts the camera on +z looking towards -z (north). Increasing yaw moves the camera towards +x.
 */
export function orbitDir(yaw: number, pitch: number, out: { x: number; y: number; z: number }): void {
  const cp = Math.cos(pitch);
  out.x = Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = Math.cos(yaw) * cp;
}

export interface Aabb {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/** Entry distance of a ray into a box, or Infinity if it does not hit within [0,maxT]. `inside` set if origin is inside. */
export function rayBoxEntry(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, b: Aabb, maxT: number): number {
  let tmin = 0;
  let tmax = maxT;
  const slab = (o: number, d: number, lo: number, hi: number): boolean => {
    if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    return tmin <= tmax;
  };
  if (!slab(ox, dx, b.minX, b.maxX)) return Infinity;
  if (!slab(oy, dy, b.minY, b.maxY)) return Infinity;
  if (!slab(oz, dz, b.minZ, b.maxZ)) return Infinity;
  return tmin;
}

const inside = (x: number, y: number, z: number, b: Aabb): boolean => x > b.minX && x < b.maxX && y > b.minY && y < b.maxY && z > b.minZ && z < b.maxZ;

/**
 * Distance along the ray (unit direction d) from the target at which the camera must stop so it stays in front of
 * every box (inflated by `margin`). Returns `desired` when nothing is in the way.
 */
export function cameraClearDistance(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  desired: number, boxes: readonly Aabb[], margin = 0.4, minDist = 0.9,
): number {
  let best = desired;
  const infl: Aabb = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  for (const b of boxes) {
    if (inside(ox, oy, oz, b)) continue;
    infl.minX = b.minX - margin; infl.maxX = b.maxX + margin;
    infl.minY = b.minY - margin; infl.maxY = b.maxY + margin;
    infl.minZ = b.minZ - margin; infl.maxZ = b.maxZ + margin;
    let t: number;
    if (inside(ox, oy, oz, infl)) {
      // already within the margin shell: only the real box can obstruct
      t = rayBoxEntry(ox, oy, oz, dx, dy, dz, b, best);
      if (t !== Infinity) t = Math.max(0, t - 0.1);
    } else {
      t = rayBoxEntry(ox, oy, oz, dx, dy, dz, infl, best);
    }
    if (t < best) best = t;
  }
  return best < desired ? Math.max(minDist, best) : desired;
}
