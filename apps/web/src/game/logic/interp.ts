import type { Anim } from '../../types';

export interface Snapshot {
  t: number;
  x: number;
  z: number;
  ry: number;
  anim: Anim;
}
export interface SampledPose {
  x: number;
  z: number;
  ry: number;
  anim: Anim;
  /** planar speed in m/s implied by the snapshots */
  speed: number;
}

export const RENDER_DELAY_S = 0.12;
export const MAX_EXTRAPOLATION_S = 0.15;
/** after this long without any snapshot we stop extrapolating at all */
export const STALE_AFTER_S = 2.5;
/** jumps longer than this (metres) between two snapshots are teleports: no interpolation */
export const TELEPORT_DIST = 10;

const TWO_PI = Math.PI * 2;
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return a + d * t;
}

/** Shortest signed angle difference b-a in (-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d <= -Math.PI) d += TWO_PI;
  return d;
}

/**
 * Sample the snapshot buffer at `now - delay`. Interpolates between the bracketing entries, extrapolates at most
 * `maxExtrap` seconds past the newest one using the last velocity, and never extrapolates stale data.
 * Returns false when the buffer is empty.
 */
export function sampleSnapshots(
  buf: readonly Snapshot[],
  now: number,
  out: SampledPose,
  delay = RENDER_DELAY_S,
  maxExtrap = MAX_EXTRAPOLATION_S,
): boolean {
  const n = buf.length;
  if (n === 0) return false;
  const rt = now - delay;
  const last = buf[n - 1];
  if (n === 1 || rt >= last.t) {
    let x = last.x;
    let z = last.z;
    let speed = 0;
    if (n >= 2) {
      const prev = buf[n - 2];
      const dt = last.t - prev.t;
      const over = rt - last.t;
      const jump = Math.hypot(last.x - prev.x, last.z - prev.z);
      if (dt > 1e-4 && over > 0 && now - last.t < STALE_AFTER_S && jump < TELEPORT_DIST) {
        const vx = (last.x - prev.x) / dt;
        const vz = (last.z - prev.z) / dt;
        const e = Math.min(over, maxExtrap);
        x += vx * e;
        z += vz * e;
        if (over <= maxExtrap) speed = Math.hypot(vx, vz);
      } else if (over <= 0 && dt > 1e-4 && jump < TELEPORT_DIST) {
        speed = jump / dt;
      }
    }
    out.x = x;
    out.z = z;
    out.ry = last.ry;
    out.anim = last.anim;
    out.speed = speed;
    return true;
  }
  const first = buf[0];
  if (rt <= first.t) {
    out.x = first.x;
    out.z = first.z;
    out.ry = first.ry;
    out.anim = first.anim;
    out.speed = 0;
    return true;
  }
  let i = n - 2;
  while (i > 0 && buf[i].t > rt) i--;
  const a = buf[i];
  const b = buf[i + 1];
  const dt = b.t - a.t;
  const dist = Math.hypot(b.x - a.x, b.z - a.z);
  if (dist >= TELEPORT_DIST) {
    out.x = b.x;
    out.z = b.z;
    out.ry = b.ry;
    out.anim = b.anim;
    out.speed = 0;
    return true;
  }
  const u = dt > 1e-6 ? Math.min(1, Math.max(0, (rt - a.t) / dt)) : 1;
  out.x = a.x + (b.x - a.x) * u;
  out.z = a.z + (b.z - a.z) * u;
  out.ry = lerpAngle(a.ry, b.ry, u);
  out.anim = u < 0.5 ? a.anim : b.anim;
  out.speed = dt > 1e-3 ? dist / dt : 0;
  return true;
}

/** Drop snapshots that can no longer be needed (older than `keepSeconds` before `now`), keeping at least two. */
export function pruneSnapshots(buf: Snapshot[], now: number, keepSeconds = 1.5): void {
  let drop = 0;
  while (buf.length - drop > 2 && buf[drop + 1].t < now - keepSeconds) drop++;
  if (drop > 0) buf.splice(0, drop);
}

/** Pick the body animation for a remote: explicit emotes win; otherwise derive from speed. */
export function effectiveAnim(anim: Anim, speed: number): Anim {
  if (anim === 'wave' || anim === 'dance' || anim === 'cheer') return anim;
  if (speed > 4.4) return 'run';
  if (speed > 0.35) return 'walk';
  return 'idle';
}
