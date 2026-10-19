import { INTERACT_RADIUS, SHOP_COUNTER } from '@pixels/shared';

/** The server only sells within this distance of the counter footprint (INTERACT_RADIUS + 1). */
export const SHOP_RANGE = INTERACT_RADIUS + 1;
/** Client-side slack so a slightly stale local position never blocks a purchase the server would allow. */
export const SHOP_RANGE_CLIENT_SLACK = 1.5;

/** Distance from a point to the counter's footprint (0 when standing on it). Mirrors the server's rule. */
export function distanceToShopCounter(x: number, z: number): number {
  const dx = Math.max(Math.abs(x - SHOP_COUNTER.x) - SHOP_COUNTER.w / 2, 0);
  const dz = Math.max(Math.abs(z - SHOP_COUNTER.z) - SHOP_COUNTER.d / 2, 0);
  return Math.hypot(dx, dz);
}

export const isFarFromShop = (x: number, z: number): boolean => distanceToShopCounter(x, z) > SHOP_RANGE + SHOP_RANGE_CLIENT_SLACK;
