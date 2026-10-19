import type { Point } from '../../types';

export const WAYPOINT_RADIUS = 1.0;
export const ARRIVE_STOP = 1.2;
/** if we are blocked for STUCK_SECONDS but already this close to the end, count it as arrived */
export const ARRIVE_LOOSE = 2.6;
export const RUN_DISTANCE = 12;
export const STUCK_SECONDS = 2;
export const STUCK_PROGRESS = 0.3;

export interface PathFollower {
  index: number;
  lastIndex: number;
  best: number;
  stuckFor: number;
}
export type SteerStatus = 'moving' | 'arrived' | 'blocked';
export interface SteerOut {
  dirX: number;
  dirZ: number;
  run: boolean;
  status: SteerStatus;
  remaining: number;
}

export const createFollower = (): PathFollower => ({ index: 0, lastIndex: -1, best: Infinity, stuckFor: 0 });
export const makeSteerOut = (): SteerOut => ({ dirX: 0, dirZ: 0, run: false, status: 'moving', remaining: 0 });

export function pathRemaining(px: number, pz: number, pts: readonly Point[], from: number): number {
  let len = 0;
  let cx = px;
  let cz = pz;
  for (let i = from; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - cx, pts[i].z - cz);
    cx = pts[i].x;
    cz = pts[i].z;
  }
  return len;
}

/**
 * Steering for auto-walk. Advances through waypoints (within 1 m), stops within ~1.2 m of the end, runs when the
 * remaining path is long and reports 'blocked' when no progress is made for 2 s.
 */
export function steerAlongPath(f: PathFollower, px: number, pz: number, pts: readonly Point[], dt: number, out: SteerOut): SteerOut {
  out.dirX = 0;
  out.dirZ = 0;
  out.run = false;
  out.status = 'moving';
  if (pts.length === 0) {
    out.status = 'arrived';
    out.remaining = 0;
    return out;
  }
  const end = pts[pts.length - 1];
  const dEnd = Math.hypot(end.x - px, end.z - pz);
  if (dEnd <= ARRIVE_STOP) {
    out.status = 'arrived';
    out.remaining = dEnd;
    return out;
  }
  if (f.index >= pts.length) f.index = pts.length - 1;
  while (f.index < pts.length - 1 && Math.hypot(pts[f.index].x - px, pts[f.index].z - pz) <= WAYPOINT_RADIUS) f.index++;
  const tgt = pts[f.index];
  const dx = tgt.x - px;
  const dz = tgt.z - pz;
  const d = Math.hypot(dx, dz);
  if (d > 1e-6) {
    out.dirX = dx / d;
    out.dirZ = dz / d;
  }
  out.remaining = pathRemaining(px, pz, pts, f.index);
  out.run = out.remaining > RUN_DISTANCE;
  if (f.lastIndex !== f.index) {
    f.lastIndex = f.index;
    f.best = d;
    f.stuckFor = 0;
  } else if (d < f.best - STUCK_PROGRESS) {
    f.best = d;
    f.stuckFor = 0;
  } else {
    f.stuckFor += dt;
  }
  if (f.stuckFor > STUCK_SECONDS) out.status = dEnd <= ARRIVE_LOOSE ? 'arrived' : 'blocked';
  return out;
}
