import * as THREE from 'three';
import { mulberry32 } from '../logic/palette';

export { mulberry32 };

export function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(w));
  canvas.height = Math.max(2, Math.round(h));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return { canvas, ctx };
}

export function toTexture(canvas: HTMLCanvasElement, opts: { repeat?: boolean; srgb?: boolean; aniso?: number; mip?: boolean } = {}): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  if (opts.repeat !== false) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  t.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = opts.aniso ?? 8;
  t.generateMipmaps = opts.mip !== false;
  t.minFilter = opts.mip === false ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Tileable value noise in [0,1) of size n*n using a lattice of `cells` cells. */
export function tileNoise(n: number, cells: number, rng: () => number): Float32Array {
  const lat = new Float32Array(cells * cells);
  for (let i = 0; i < lat.length; i++) lat[i] = rng();
  const out = new Float32Array(n * n);
  const s = cells / n;
  for (let y = 0; y < n; y++) {
    const fy = y * s;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const sy = ty * ty * (3 - 2 * ty);
    const ya = (y0 % cells) * cells;
    const yb = ((y0 + 1) % cells) * cells;
    for (let x = 0; x < n; x++) {
      const fx = x * s;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const sx = tx * tx * (3 - 2 * tx);
      const xa = x0 % cells;
      const xb = (x0 + 1) % cells;
      const a = lat[ya + xa] + (lat[ya + xb] - lat[ya + xa]) * sx;
      const b = lat[yb + xa] + (lat[yb + xb] - lat[yb + xa]) * sx;
      out[y * n + x] = a + (b - a) * sy;
    }
  }
  return out;
}

/** Fractal tileable noise normalised to ~[0,1]. */
export function fbm(n: number, baseCells: number, octaves: number, rng: () => number): Float32Array {
  const out = new Float32Array(n * n);
  let amp = 1;
  let total = 0;
  let cells = baseCells;
  for (let o = 0; o < octaves; o++) {
    const layer = tileNoise(n, cells, rng);
    for (let i = 0; i < out.length; i++) out[i] += layer[i] * amp;
    total += amp;
    amp *= 0.5;
    cells *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

export function hexToRgb(hex: string): [number, number, number] {
  const c = new THREE.Color(hex);
  // Color stores linear values; convert back to sRGB bytes
  const s = c.clone().convertLinearToSRGB();
  return [Math.round(s.r * 255), Math.round(s.g * 255), Math.round(s.b * 255)];
}

export function shade(hex: string, k: number): string {
  const [r, g, b] = hexToRgb(hex);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

export function mixHex(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return `rgb(${Math.round(r1 + (r2 - r1) * t)},${Math.round(g1 + (g2 - g1) * t)},${Math.round(b1 + (b2 - b1) * t)})`;
}

/** Fill a canvas with base colour modulated by noise (per-pixel). */
export function paintNoise(ctx: CanvasRenderingContext2D, size: number, base: [number, number, number], noise: Float32Array, contrast: number, speckle: number, rng: () => number): void {
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const k = 1 + (noise[i] - 0.5) * contrast + (rng() - 0.5) * speckle;
    d[i * 4] = Math.max(0, Math.min(255, base[0] * k));
    d[i * 4 + 1] = Math.max(0, Math.min(255, base[1] * k));
    d[i * 4 + 2] = Math.max(0, Math.min(255, base[2] * k));
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export const FONT_STACK = "'Trebuchet MS','Segoe UI','Helvetica Neue',Arial,'DejaVu Sans',sans-serif";
export const SERIF_STACK = "Georgia,'Times New Roman','DejaVu Serif',serif";

/** Draw text centred, shrinking the font to fit maxW. */
export function fitText(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, maxW: number, size: number, weight = 'bold', family = FONT_STACK): void {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  const w = ctx.measureText(text).width;
  if (w > maxW) {
    s = Math.floor((s * maxW) / w);
    ctx.font = `${weight} ${s}px ${family}`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy);
}
