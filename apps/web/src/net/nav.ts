import { ARRIVE_RADIUS, findPath, locationById, pathLength, type Point } from '@pixels/shared';
import { runtime, useGame } from '../state';

export type NavPlan =
  | { ok: true; arrived: false; points: Point[]; distance: number; label: string; locationId: string }
  | { ok: true; arrived: true; label: string; locationId: string; distance: number }
  | { ok: false; error: string };

/** Pure planning step: validate the location and compute a walking path from `from`. */
export function planNavigation(from: Point, locationId: string): NavPlan {
  const loc = locationById(locationId);
  if (!loc || loc.hidden) return { ok: false, error: "I don't know a place like that." };
  const dest = { x: loc.x, z: loc.z };
  const straight = Math.hypot(dest.x - from.x, dest.z - from.z);
  if (straight <= ARRIVE_RADIUS) return { ok: true, arrived: true, label: loc.name, locationId: loc.id, distance: Math.round(straight) };
  const points = findPath(from, dest);
  if (!points || points.length === 0) return { ok: false, error: `Can't find a walkable route to ${loc.name}.` };
  return { ok: true, arrived: false, points, distance: Math.round(pathLength(from, points)), label: loc.name, locationId: loc.id };
}

/** Plans a route from the local player and, on success, hands it to the 3D controller via runtime.navPath. */
export function startNavigation(locationId: string): NavPlan {
  const toast = useGame.getState().toast;
  const plan = planNavigation({ x: runtime.local.x, z: runtime.local.z }, locationId);
  if (!plan.ok) {
    toast(plan.error, 'warn');
  } else if (plan.arrived) {
    runtime.navPath = null;
    toast(`You're already at ${plan.label}.`);
  } else {
    runtime.navPath = { points: plan.points, label: plan.label, locationId: plan.locationId };
    toast(`Walking to ${plan.label} (${plan.distance} m). Move manually to cancel.`);
  }
  return plan;
}

export function stopNavigation(): void {
  runtime.navPath = null;
}
