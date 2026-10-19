import { BUILDINGS, FOUNTAIN, GAZEBO, POND, PLAYGROUND, PROPS, ROAD, CROSS_ROAD, SHOP_COUNTER, WORLD_BOUNDS } from '@pixels/shared';

/** Pre-rendered resolution of the static map layer (pixels per metre). */
export const PX_PER_M = 5;
export const WORLD_SIZE = WORLD_BOUNDS.maxX - WORLD_BOUNDS.minX;

/**
 * World (metres, x east / z south) -> minimap pixels. The map is centred on the player (px,pz) and rotated by
 * `rot` radians clockwise on screen (rot = camera yaw => camera-forward points up; rot = 0 => north up).
 */
export function worldToView(wx: number, wz: number, px: number, pz: number, rot: number, k: number, cx: number, cy: number): { x: number; y: number } {
  const dx = (wx - px) * k;
  const dz = (wz - pz) * k;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return { x: cx + dx * c - dz * s, y: cy + dx * s + dz * c };
}

export function viewToWorld(vx: number, vy: number, px: number, pz: number, rot: number, k: number, cx: number, cy: number): { x: number; z: number } {
  const ax = vx - cx;
  const ay = vy - cy;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return { x: px + (ax * c + ay * s) / k, z: pz + (-ax * s + ay * c) / k };
}

/** Pulls a view-space point onto a circle of radius `r` around (cx,cy) if it lies outside. */
export function clampToCircle(x: number, y: number, cx: number, cy: number, r: number): { x: number; y: number; clamped: boolean } {
  const dx = x - cx;
  const dy = y - cy;
  const d = Math.hypot(dx, dy);
  if (d <= r) return { x, y, clamped: false };
  return { x: cx + (dx / d) * r, y: cy + (dy / d) * r, clamped: true };
}

let cached: HTMLCanvasElement | null = null;

/** Roads, buildings, park, pond ... drawn once from the shared world data. */
export function getStaticLayer(): HTMLCanvasElement {
  if (cached) return cached;
  const S = Math.round(WORLD_SIZE * PX_PER_M);
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d');
  if (!g) {
    cached = c;
    return c;
  }
  const X = (x: number) => (x - WORLD_BOUNDS.minX) * PX_PER_M;
  const Z = (z: number) => (z - WORLD_BOUNDS.minZ) * PX_PER_M;
  const M = (m: number) => m * PX_PER_M;
  const rect = (x0: number, z0: number, x1: number, z1: number, fill: string) => {
    g.fillStyle = fill;
    g.fillRect(X(x0), Z(z0), M(x1 - x0), M(z1 - z0));
  };
  const disc = (x: number, z: number, r: number, fill: string, stroke?: string, lw = 1.2) => {
    g.beginPath();
    g.arc(X(x), Z(z), M(r), 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
    if (stroke) {
      g.strokeStyle = stroke;
      g.lineWidth = lw;
      g.stroke();
    }
  };

  // ground
  rect(WORLD_BOUNDS.minX, WORLD_BOUNDS.minZ, WORLD_BOUNDS.maxX, WORLD_BOUNDS.maxZ, '#5a9a5c');
  // park (north of the building row)
  rect(WORLD_BOUNDS.minX, WORLD_BOUNDS.minZ, WORLD_BOUNDS.maxX, -30, '#4a8a52');
  // plaza paving (south of the main street)
  rect(-9, ROAD.maxZ + ROAD.sidewalk, 13, ROAD.maxZ + ROAD.sidewalk + 36, '#cfc7b4');
  // sidewalks + main street + cross street
  rect(WORLD_BOUNDS.minX, ROAD.minZ - ROAD.sidewalk, WORLD_BOUNDS.maxX, ROAD.minZ, '#b8b3a6');
  rect(WORLD_BOUNDS.minX, ROAD.maxZ, WORLD_BOUNDS.maxX, ROAD.maxZ + ROAD.sidewalk, '#b8b3a6');
  rect(WORLD_BOUNDS.minX, ROAD.minZ, WORLD_BOUNDS.maxX, ROAD.maxZ, '#4b505c');
  rect(CROSS_ROAD.minX, CROSS_ROAD.minZ, CROSS_ROAD.maxX, CROSS_ROAD.maxZ, '#4b505c');
  // lane markings
  g.strokeStyle = 'rgba(255,224,130,0.8)';
  g.lineWidth = 1.4;
  g.setLineDash([M(2), M(2)]);
  g.beginPath();
  g.moveTo(X(WORLD_BOUNDS.minX), Z(0));
  g.lineTo(X(WORLD_BOUNDS.maxX), Z(0));
  g.stroke();
  g.setLineDash([]);

  // water + fountain + gazebo + playground
  disc(POND.x, POND.z, POND.r + 0.8, '#6fae6a');
  disc(POND.x, POND.z, POND.r, '#4aa3d8', '#2b7fb0');
  disc(FOUNTAIN.x, FOUNTAIN.z, FOUNTAIN.r + 0.5, '#e4e0d4');
  disc(FOUNTAIN.x, FOUNTAIN.z, FOUNTAIN.r, '#7cc7ee', '#a5b0b8');
  rect(GAZEBO.x - 3, GAZEBO.z - 3, GAZEBO.x + 3, GAZEBO.z + 3, '#c9b48a');
  rect(GAZEBO.x - 2.2, GAZEBO.z - 2.2, GAZEBO.x + 2.2, GAZEBO.z + 2.2, '#8d6e63');
  rect(PLAYGROUND.x - 8, PLAYGROUND.z - 6, PLAYGROUND.x + 9, PLAYGROUND.z + 6, '#dcc88a');

  // buildings
  for (const b of BUILDINGS) {
    rect(b.x - b.w / 2, b.z - b.d / 2, b.x + b.w / 2, b.z + b.d / 2, b.roof);
    rect(b.x - b.w / 2 + 0.7, b.z - b.d / 2 + 0.7, b.x + b.w / 2 - 0.7, b.z + b.d / 2 - 0.7, b.color);
    const doorZ = b.door === 'S' ? b.z + b.d / 2 : b.z - b.d / 2;
    rect(b.x - 1.2, doorZ - 0.5, b.x + 1.2, doorZ + 0.5, '#2b2b33');
  }
  // shop kiosk
  rect(SHOP_COUNTER.x - SHOP_COUNTER.w / 2, SHOP_COUNTER.z - SHOP_COUNTER.d / 2, SHOP_COUNTER.x + SHOP_COUNTER.w / 2, SHOP_COUNTER.z + SHOP_COUNTER.d / 2, '#f2b84b');

  // props
  for (const p of PROPS) {
    if (p.kind === 'tree') disc(p.x, p.z, 1.0 * (p.scale ?? 1) + 0.3, '#2f6b3a');
    else if (p.kind === 'lamp') disc(p.x, p.z, 0.45, '#f5e6a8');
    else if (p.kind === 'bench') rect(p.x - 0.9, p.z - 0.4, p.x + 0.9, p.z + 0.4, '#8d6e63');
    else if (p.kind === 'swing') rect(p.x - 2, p.z - 0.4, p.x + 2, p.z + 0.4, '#d9534f');
    else if (p.kind === 'slide') rect(p.x - 0.6, p.z - 1.6, p.x + 0.6, p.z + 1.6, '#4f8ef0');
    else if (p.kind === 'sandbox') rect(p.x - 2, p.z - 1.5, p.x + 2, p.z + 1.5, '#efdca0');
  }

  // world edge
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, S - 3, S - 3);
  cached = c;
  return c;
}
