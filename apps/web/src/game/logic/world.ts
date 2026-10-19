import { BUILDINGS, COLLIDERS, type Building } from '@pixels/shared';
import type { Aabb } from './camera';

/** Boxes used for camera occlusion (3D). Pitched roofs / the clock tower are covered by generous heights. */
export function buildCameraBoxes(): Aabb[] {
  const boxes: Aabb[] = [];
  for (const b of BUILDINGS) {
    boxes.push({ minX: b.x - b.w / 2, maxX: b.x + b.w / 2, minY: -0.5, maxY: b.h + roofRise(b), minZ: b.z - b.d / 2, maxZ: b.z + b.d / 2 });
  }
  return boxes;
}

export function roofRise(b: Building): number {
  switch (b.kind) {
    case 'bakery': return 2.2;
    case 'cafe': return 1.8;
    case 'library': return 2.4;
    case 'hall': return 2.2;
    default: return 1.0;
  }
}

export { COLLIDERS };
