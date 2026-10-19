import { INTERACT_RADIUS, SHOP_COUNTER } from '@pixels/shared';
import type { MissionStateView } from '../../types';

export type InteractAction = { kind: 'shop' } | { kind: 'interact'; target: string };
export interface Interactable {
  prompt: string;
  action: InteractAction;
  distance: number;
}

/** objective ids may carry a prefix like "pickup:bakery": the interact target is the part after the last ':' */
export function objectiveTarget(id: string): string {
  const i = id.lastIndexOf(':');
  return i >= 0 ? id.slice(i + 1) : id;
}

export const PROMPTS = {
  shop: 'Press E to open the shop',
  pickup: 'Press E to pick up the parcel',
  dropoff: 'Press E to deliver',
  collect: 'Press E to collect the treasure',
} as const;

/** Nearest interactable to (px,pz) or null. Mission objectives only count while the mission is active and the objective current. */
export function pickInteractable(px: number, pz: number, mission: MissionStateView | null, radius = INTERACT_RADIUS): Interactable | null {
  let best: Interactable | null = null;
  const dShop = Math.hypot(px - SHOP_COUNTER.x, pz - SHOP_COUNTER.z);
  if (dShop < radius) best = { prompt: PROMPTS.shop, action: { kind: 'shop' }, distance: dShop };
  if (mission) {
    const o = mission.objectives[mission.current];
    if (o && !o.done && (o.kind === 'pickup' || o.kind === 'dropoff' || o.kind === 'collect')) {
      const d = Math.hypot(px - o.x, pz - o.z);
      if (d < radius && (!best || d < best.distance)) {
        best = { prompt: PROMPTS[o.kind], action: { kind: 'interact', target: objectiveTarget(o.id) }, distance: d };
      }
    }
  }
  return best;
}
