import { WORLD_BOUNDS } from './constants';

export type BoxCollider = { kind: 'box'; minX: number; maxX: number; minZ: number; maxZ: number };
export type CircleCollider = { kind: 'circle'; x: number; z: number; r: number };
export type Collider = BoxCollider | CircleCollider;

export function box(cx: number, cz: number, w: number, d: number): BoxCollider {
  return { kind: 'box', minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2 };
}
export function circle(x: number, z: number, r: number): CircleCollider {
  return { kind: 'circle', x, z, r };
}

/** Push (x,z) with the given radius out of one collider. Returns the new position, or null if not overlapping. */
function pushOut(x: number, z: number, radius: number, c: Collider): [number, number] | null {
  if (c.kind === 'circle') {
    const dx = x - c.x;
    const dz = z - c.z;
    const min = radius + c.r;
    const d2 = dx * dx + dz * dz;
    if (d2 >= min * min) return null;
    const d = Math.sqrt(d2);
    if (d < 1e-6) return [c.x + min, c.z];
    return [c.x + (dx / d) * min, c.z + (dz / d) * min];
  }
  const nx = Math.max(c.minX, Math.min(x, c.maxX));
  const nz = Math.max(c.minZ, Math.min(z, c.maxZ));
  const dx = x - nx;
  const dz = z - nz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= radius * radius) return null;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    return [nx + (dx / d) * radius, nz + (dz / d) * radius];
  }
  // centre is inside the box: leave through the nearest face
  const left = x - c.minX;
  const right = c.maxX - x;
  const top = z - c.minZ;
  const bottom = c.maxZ - z;
  const m = Math.min(left, right, top, bottom);
  if (m === left) return [c.minX - radius, z];
  if (m === right) return [c.maxX + radius, z];
  if (m === top) return [x, c.minZ - radius];
  return [x, c.maxZ + radius];
}

export function clampToBounds(x: number, z: number, radius: number): [number, number] {
  return [
    Math.max(WORLD_BOUNDS.minX + radius, Math.min(WORLD_BOUNDS.maxX - radius, x)),
    Math.max(WORLD_BOUNDS.minZ + radius, Math.min(WORLD_BOUNDS.maxZ - radius, z)),
  ];
}

/** Resolve a desired position against all colliders and the world bounds (sliding behaviour). */
export function resolveCollisions(x: number, z: number, radius: number, colliders: readonly Collider[]): [number, number] {
  let px = x;
  let pz = z;
  [px, pz] = clampToBounds(px, pz, radius);
  for (let iter = 0; iter < 4; iter++) {
    let moved = false;
    for (const c of colliders) {
      const r = pushOut(px, pz, radius, c);
      if (r) {
        px = r[0];
        pz = r[1];
        moved = true;
      }
    }
    [px, pz] = clampToBounds(px, pz, radius);
    if (!moved) break;
  }
  return [px, pz];
}

export function isBlocked(x: number, z: number, radius: number, colliders: readonly Collider[]): boolean {
  if (x < WORLD_BOUNDS.minX + radius || x > WORLD_BOUNDS.maxX - radius) return true;
  if (z < WORLD_BOUNDS.minZ + radius || z > WORLD_BOUNDS.maxZ - radius) return true;
  for (const c of colliders) if (pushOut(x, z, radius, c)) return true;
  return false;
}

/** 2D segment-vs-colliders test used for camera occlusion & path smoothing. */
export function segmentBlocked(ax: number, az: number, bx: number, bz: number, radius: number, colliders: readonly Collider[]): boolean {
  const len = Math.hypot(bx - ax, bz - az);
  const steps = Math.max(1, Math.ceil(len / 0.4));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (isBlocked(ax + (bx - ax) * t, az + (bz - az) * t, radius, colliders)) return true;
  }
  return false;
}
