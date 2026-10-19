/** Pure terrain height outside the town (the walkable square is perfectly flat). */
const hash2 = (x: number, y: number): number => {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) % 100000) / 100000;
};
export function valueNoise2(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash2(x0, y0);
  const b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1);
  const d = hash2(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
export function fbm2(x: number, y: number, oct = 4): number {
  let amp = 0.5;
  let f = 1;
  let s = 0;
  let tot = 0;
  for (let i = 0; i < oct; i++) {
    s += valueNoise2(x * f, y * f) * amp;
    tot += amp;
    amp *= 0.5;
    f *= 2;
  }
  return s / tot;
}
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Edge of the flat town square (hedge line is at 58.6). */
export const FLAT_EXTENT = 61;

/** Height of the surrounding land: flat inside the town, rolling hills, then a mountain ring. */
export function outerHeight(x: number, z: number): number {
  const sq = Math.max(Math.abs(x), Math.abs(z));
  const r = Math.hypot(x, z);
  const roll = smooth(FLAT_EXTENT, 150, sq);
  const hills = roll * (1.5 + fbm2(x * 0.014 + 7.3, z * 0.014 - 3.1) * 15);
  const ridgeN = fbm2(x * 0.0075 + 31.7, z * 0.0075 + 11.9, 5);
  const ridge = 1 - Math.abs(ridgeN * 2 - 1);
  const mt = smooth(190, 360, r) * (28 + ridge * ridge * 120 + fbm2(x * 0.02, z * 0.02) * 30);
  return hills + mt;
}
