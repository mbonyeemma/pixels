import { isBlocked, segmentBlocked, type Collider } from './collision';
import { PLAYER_RADIUS, WORLD_BOUNDS } from './constants';
import { COLLIDERS } from './world';

const CELL = 1;
const NAV_RADIUS = PLAYER_RADIUS + 0.25;
const W = Math.ceil((WORLD_BOUNDS.maxX - WORLD_BOUNDS.minX) / CELL);
const H = Math.ceil((WORLD_BOUNDS.maxZ - WORLD_BOUNDS.minZ) / CELL);

const gridCache = new WeakMap<readonly Collider[], Uint8Array>();

function grid(colliders: readonly Collider[]): Uint8Array {
  let g = gridCache.get(colliders);
  if (!g) {
    g = new Uint8Array(W * H);
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const [x, z] = cellCenter(i, j);
        g[j * W + i] = isBlocked(x, z, NAV_RADIUS, colliders) ? 1 : 0;
      }
    gridCache.set(colliders, g);
  }
  return g;
}

const cellCenter = (i: number, j: number): [number, number] => [WORLD_BOUNDS.minX + (i + 0.5) * CELL, WORLD_BOUNDS.minZ + (j + 0.5) * CELL];
const toCell = (x: number, z: number): [number, number] => [
  Math.max(0, Math.min(W - 1, Math.floor((x - WORLD_BOUNDS.minX) / CELL))),
  Math.max(0, Math.min(H - 1, Math.floor((z - WORLD_BOUNDS.minZ) / CELL))),
];

/** Nearest unblocked cell to (i,j), searching outward. */
function nearestFree(g: Uint8Array, i: number, j: number): [number, number] | null {
  if (!g[j * W + i]) return [i, j];
  for (let r = 1; r < 12; r++)
    for (let dj = -r; dj <= r; dj++)
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        if (!g[nj * W + ni]) return [ni, nj];
      }
  return null;
}

export type Point = { x: number; z: number };

/**
 * A* over a 1 m grid, then string-pulled to a short list of waypoints.
 * Returns the waypoints to walk through (excluding the start, including the goal), or null if unreachable.
 */
export function findPath(from: Point, to: Point, colliders: readonly Collider[] = COLLIDERS): Point[] | null {
  const g = grid(colliders);
  const s = nearestFree(g, ...toCell(from.x, from.z));
  const e = nearestFree(g, ...toCell(to.x, to.z));
  if (!s || !e) return null;
  if (!segmentBlocked(from.x, from.z, to.x, to.z, NAV_RADIUS - 0.1, colliders)) return [{ x: to.x, z: to.z }];

  const idx = (i: number, j: number) => j * W + i;
  const gScore = new Float32Array(W * H).fill(Infinity);
  const came = new Int32Array(W * H).fill(-1);
  const closed = new Uint8Array(W * H);
  const open: { f: number; i: number; j: number }[] = [];
  const push = (n: { f: number; i: number; j: number }) => {
    open.push(n);
    let k = open.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (open[p].f <= open[k].f) break;
      [open[p], open[k]] = [open[k], open[p]];
      k = p;
    }
  };
  const pop = () => {
    const top = open[0];
    const last = open.pop()!;
    if (open.length) {
      open[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < open.length && open[l].f < open[m].f) m = l;
        if (r < open.length && open[r].f < open[m].f) m = r;
        if (m === k) break;
        [open[m], open[k]] = [open[k], open[m]];
        k = m;
      }
    }
    return top;
  };
  const h = (i: number, j: number) => Math.hypot(i - e[0], j - e[1]);
  gScore[idx(s[0], s[1])] = 0;
  push({ f: h(s[0], s[1]), i: s[0], j: s[1] });
  let found = false;
  while (open.length) {
    const cur = pop();
    const ci = idx(cur.i, cur.j);
    if (closed[ci]) continue;
    closed[ci] = 1;
    if (cur.i === e[0] && cur.j === e[1]) {
      found = true;
      break;
    }
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = cur.i + di;
        const nj = cur.j + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H || g[idx(ni, nj)] || closed[idx(ni, nj)]) continue;
        if (di && dj && (g[idx(cur.i + di, cur.j)] || g[idx(cur.i, cur.j + dj)])) continue; // no corner cutting
        const ng = gScore[ci] + (di && dj ? Math.SQRT2 : 1);
        if (ng < gScore[idx(ni, nj)]) {
          gScore[idx(ni, nj)] = ng;
          came[idx(ni, nj)] = ci;
          push({ f: ng + h(ni, nj), i: ni, j: nj });
        }
      }
  }
  if (!found) return null;
  const cells: Point[] = [];
  for (let c = idx(e[0], e[1]); c !== -1; c = came[c]) {
    const [x, z] = cellCenter(c % W, Math.floor(c / W));
    cells.push({ x, z });
  }
  cells.reverse();
  // string pulling
  const pts: Point[] = [{ x: from.x, z: from.z }, ...cells.slice(1), { x: to.x, z: to.z }];
  const out: Point[] = [];
  let anchor = 0;
  while (anchor < pts.length - 1) {
    let far = pts.length - 1;
    while (far > anchor + 1 && segmentBlocked(pts[anchor].x, pts[anchor].z, pts[far].x, pts[far].z, NAV_RADIUS - 0.1, colliders)) far--;
    out.push(pts[far]);
    anchor = far;
  }
  return out;
}

export function pathLength(from: Point, path: Point[]): number {
  let len = 0;
  let px = from.x;
  let pz = from.z;
  for (const p of path) {
    len += Math.hypot(p.x - px, p.z - pz);
    px = p.x;
    pz = p.z;
  }
  return len;
}

/** Walking distance between two points, or Infinity if unreachable. */
export function walkDistance(a: Point, b: Point): number {
  const p = findPath(a, b);
  return p ? pathLength(a, p) : Infinity;
}
