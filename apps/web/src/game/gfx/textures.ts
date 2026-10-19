import * as THREE from 'three';
import { fbm, hexToRgb, makeCanvas, mulberry32, paintNoise, shade, toTexture } from './canvasUtil';

/** Procedural canvas textures for the ground, props and roofs. Facades/signs live in facade.ts. */
export interface Textures {
  asphalt: THREE.CanvasTexture;
  sidewalk: THREE.CanvasTexture;
  plaza: THREE.CanvasTexture;
  grass: THREE.CanvasTexture;
  gravel: THREE.CanvasTexture;
  roofTile: THREE.CanvasTexture;
  roofFlat: THREE.CanvasTexture;
  hedge: THREE.CanvasTexture;
  wood: THREE.CanvasTexture;
  stone: THREE.CanvasTexture;
  sand: THREE.CanvasTexture;
  rubber: THREE.CanvasTexture;
  waterNormal: THREE.CanvasTexture;
  softCircle: THREE.CanvasTexture;
  beam: THREE.CanvasTexture;
  chevron: THREE.CanvasTexture;
  dispose(): void;
}

function asphalt(): HTMLCanvasElement {
  const N = 512;
  const rng = mulberry32(11);
  const { canvas, ctx } = makeCanvas(N, N);
  paintNoise(ctx, N, [64, 67, 73], fbm(N, 4, 5, rng), 0.55, 0.28, rng);
  // light aggregate flecks
  for (let i = 0; i < 1400; i++) {
    const v = 90 + rng() * 80;
    ctx.fillStyle = `rgba(${v},${v},${v + 4},${0.18 + rng() * 0.25})`;
    ctx.fillRect(rng() * N, rng() * N, 1 + rng() * 1.5, 1 + rng() * 1.5);
  }
  // hairline cracks
  ctx.strokeStyle = 'rgba(15,15,18,0.38)';
  ctx.lineWidth = 1.1;
  for (let i = 0; i < 7; i++) {
    let x = rng() * N;
    let y = rng() * N;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 14; s++) {
      x += (rng() - 0.5) * 34;
      y += (rng() - 0.3) * 24;
      ctx.lineTo(((x % N) + N) % N, ((y % N) + N) % N);
    }
    ctx.stroke();
  }
  return canvas;
}

function sidewalk(): HTMLCanvasElement {
  const N = 512;
  const rng = mulberry32(21);
  const { canvas, ctx } = makeCanvas(N, N);
  paintNoise(ctx, N, [186, 183, 174], fbm(N, 6, 4, rng), 0.22, 0.12, rng);
  const slabs = 4;
  const S = N / slabs;
  for (let j = 0; j < slabs; j++)
    for (let i = 0; i < slabs; i++) {
      const k = (rng() - 0.5) * 0.12;
      ctx.fillStyle = k > 0 ? `rgba(255,255,255,${k})` : `rgba(0,0,0,${-k})`;
      ctx.fillRect(i * S, j * S, S, S);
    }
  ctx.strokeStyle = 'rgba(60,58,52,0.75)';
  ctx.lineWidth = 3;
  for (let i = 0; i <= slabs; i++) {
    ctx.beginPath(); ctx.moveTo(i * S, 0); ctx.lineTo(i * S, N); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * S); ctx.lineTo(N, i * S); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < slabs; i++) {
    ctx.beginPath(); ctx.moveTo(i * S + 3, 0); ctx.lineTo(i * S + 3, N); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * S + 3); ctx.lineTo(N, i * S + 3); ctx.stroke();
  }
  return canvas;
}

function plaza(): HTMLCanvasElement {
  const N = 1024;
  const rng = mulberry32(31);
  const { canvas, ctx } = makeCanvas(N, N);
  ctx.fillStyle = '#9d927f';
  ctx.fillRect(0, 0, N, N);
  const palette = ['#d9cdb4', '#cdbf9f', '#c4b490', '#d3c5a8', '#bfae8c', '#dccfb6'];
  const cols = 8;
  const rows = 16;
  const bw = N / cols;
  const bh = N / rows;
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * bw * 0.5;
    for (let c = -1; c < cols; c++) {
      const x = c * bw + off;
      const base = palette[Math.floor(rng() * palette.length)];
      ctx.fillStyle = base;
      ctx.fillRect(x + 2, r * bh + 2, bw - 4, bh - 4);
      // mottling
      for (let k = 0; k < 14; k++) {
        ctx.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(60,45,20,0.08)';
        ctx.fillRect(x + 2 + rng() * (bw - 8), r * bh + 2 + rng() * (bh - 8), 3 + rng() * 10, 2 + rng() * 6);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(x + 2, r * bh + 2, bw - 4, 2);
    }
  }
  return canvas;
}

function grass(): HTMLCanvasElement {
  const N = 512;
  const rng = mulberry32(41);
  const { canvas, ctx } = makeCanvas(N, N);
  paintNoise(ctx, N, [92, 150, 62], fbm(N, 4, 5, rng), 0.5, 0.2, rng);
  for (let i = 0; i < 3500; i++) {
    const x = rng() * N;
    const y = rng() * N;
    const l = 3 + rng() * 6;
    const g = 110 + rng() * 90;
    ctx.strokeStyle = `rgba(${40 + rng() * 60},${g},${30 + rng() * 40},${0.25 + rng() * 0.35})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rng() - 0.5) * 3, y - l);
    ctx.stroke();
  }
  // tiny clover / flower dots
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = rng() > 0.5 ? 'rgba(255,248,210,0.7)' : 'rgba(255,230,120,0.6)';
    ctx.fillRect(rng() * N, rng() * N, 2, 2);
  }
  return canvas;
}

function gravel(): HTMLCanvasElement {
  const N = 256;
  const rng = mulberry32(51);
  const { canvas, ctx } = makeCanvas(N, N);
  paintNoise(ctx, N, [176, 156, 120], fbm(N, 6, 4, rng), 0.3, 0.3, rng);
  for (let i = 0; i < 900; i++) {
    const v = 120 + rng() * 110;
    ctx.fillStyle = `rgba(${v},${v - 12},${v - 40},${0.4 + rng() * 0.4})`;
    ctx.beginPath();
    ctx.ellipse(rng() * N, rng() * N, 1 + rng() * 2.4, 1 + rng() * 1.6, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas;
}

function roofTile(): HTMLCanvasElement {
  // greyscale-ish: multiplied by the roof colour
  const N = 512;
  const rng = mulberry32(61);
  const { canvas, ctx } = makeCanvas(N, N);
  ctx.fillStyle = '#c9c9c9';
  ctx.fillRect(0, 0, N, N);
  const rows = 16;
  const cols = 12;
  const rh = N / rows;
  const cw = N / cols;
  for (let r = 0; r < rows; r++) {
    for (let c = -1; c <= cols; c++) {
      const x = c * cw + (r % 2) * cw * 0.5;
      const v = 205 + Math.floor((rng() - 0.5) * 50);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.beginPath();
      ctx.moveTo(x + 1, r * rh);
      ctx.lineTo(x + cw - 1, r * rh);
      ctx.lineTo(x + cw - 1, r * rh + rh * 0.7);
      ctx.quadraticCurveTo(x + cw / 2, r * rh + rh * 1.15, x + 1, r * rh + rh * 0.7);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(0, r * rh + rh * 0.78, N, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(0, r * rh, N, 2);
  }
  return canvas;
}

function roofFlat(): HTMLCanvasElement {
  const N = 256;
  const rng = mulberry32(71);
  const { canvas, ctx } = makeCanvas(N, N);
  paintNoise(ctx, N, [92, 92, 96], fbm(N, 5, 4, rng), 0.35, 0.4, rng);
  return canvas;
}

function hedge(): HTMLCanvasElement {
  const N = 256;
  const rng = mulberry32(81);
  const { canvas, ctx } = makeCanvas(N, N);
  paintNoise(ctx, N, [48, 104, 46], fbm(N, 8, 4, rng), 0.7, 0.4, rng);
  for (let i = 0; i < 1400; i++) {
    const g = 90 + rng() * 120;
    ctx.fillStyle = `rgba(${30 + rng() * 70},${g},${20 + rng() * 50},${0.35 + rng() * 0.4})`;
    ctx.beginPath();
    ctx.ellipse(rng() * N, rng() * N, 2 + rng() * 3, 1.2 + rng() * 2, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas;
}

function wood(): HTMLCanvasElement {
  // grayscale planks (tinted by material colour)
  const N = 256;
  const rng = mulberry32(91);
  const { canvas, ctx } = makeCanvas(N, N);
  const planks = 8;
  const ph = N / planks;
  for (let p = 0; p < planks; p++) {
    const v = 190 + Math.floor((rng() - 0.5) * 50);
    ctx.fillStyle = `rgb(${v},${v - 8},${v - 20})`;
    ctx.fillRect(0, p * ph, N, ph);
    for (let g = 0; g < 14; g++) {
      ctx.strokeStyle = `rgba(70,45,20,${0.06 + rng() * 0.12})`;
      ctx.lineWidth = 1;
      const y = p * ph + rng() * ph;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(N * 0.3, y + (rng() - 0.5) * 3, N * 0.6, y + (rng() - 0.5) * 3, N, y + (rng() - 0.5) * 2);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, p * ph, N, 2);
  }
  return canvas;
}

function stone(): HTMLCanvasElement {
  const N = 256;
  const rng = mulberry32(101);
  const { canvas, ctx } = makeCanvas(N, N);
  paintNoise(ctx, N, [176, 174, 168], fbm(N, 5, 5, rng), 0.5, 0.25, rng);
  ctx.strokeStyle = 'rgba(70,68,62,0.45)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.moveTo(0, rng() * N);
    ctx.lineTo(N, rng() * N);
    ctx.stroke();
  }
  return canvas;
}

function sand(): HTMLCanvasElement {
  const N = 256;
  const rng = mulberry32(111);
  const { canvas, ctx } = makeCanvas(N, N);
  paintNoise(ctx, N, [221, 197, 142], fbm(N, 8, 3, rng), 0.25, 0.35, rng);
  return canvas;
}

function rubber(): HTMLCanvasElement {
  const N = 256;
  const rng = mulberry32(121);
  const { canvas, ctx } = makeCanvas(N, N);
  paintNoise(ctx, N, [160, 100, 84], fbm(N, 6, 3, rng), 0.2, 0.4, rng);
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, N - 2, N - 2);
  return canvas;
}

function waterNormal(): HTMLCanvasElement {
  const N = 256;
  const rng = mulberry32(131);
  const h = fbm(N, 4, 4, rng);
  const { canvas, ctx } = makeCanvas(N, N);
  const img = ctx.createImageData(N, N);
  const get = (x: number, y: number) => h[((y + N) % N) * N + ((x + N) % N)];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const dx = (get(x + 1, y) - get(x - 1, y)) * 9;
      const dy = (get(x, y + 1) - get(x, y - 1)) * 9;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * N + x) * 4;
      img.data[i] = (-dx / l * 0.5 + 0.5) * 255;
      img.data[i + 1] = (-dy / l * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function softCircle(): HTMLCanvasElement {
  const N = 128;
  const { canvas, ctx } = makeCanvas(N, N);
  const g = ctx.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.14)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, N, N);
  return canvas;
}

function beam(): HTMLCanvasElement {
  // horizontal falloff (u) so the cylinder edge fades; vertical (v) fade at the top
  const W = 64;
  const H = 128;
  const { canvas, ctx } = makeCanvas(W, H);
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = Math.abs(x / (W - 1) - 0.5) * 2;
      const v = y / (H - 1); // 0 top .. 1 bottom
      const a = Math.pow(1 - Math.min(1, v), 1.2) * 0.55 + 0.1;
      const edge = 1 - u * u;
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.max(0, Math.min(255, a * edge * 255 * (0.35 + 0.65 * (1 - v))));
    }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function chevron(): HTMLCanvasElement {
  const N = 128;
  const { canvas, ctx } = makeCanvas(N, N);
  ctx.clearRect(0, 0, N, N);
  ctx.shadowColor = 'rgba(120,230,255,1)';
  ctx.shadowBlur = 18;
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.beginPath();
  ctx.moveTo(N * 0.5, N * 0.16);
  ctx.lineTo(N * 0.86, N * 0.7);
  ctx.lineTo(N * 0.5, N * 0.52);
  ctx.lineTo(N * 0.14, N * 0.7);
  ctx.closePath();
  ctx.fill();
  return canvas;
}

export function createTextures(): Textures {
  const aniso = 8;
  const mk = (c: HTMLCanvasElement, o: Parameters<typeof toTexture>[1] = {}) => toTexture(c, { aniso, ...o });
  const t = {
    asphalt: mk(asphalt()),
    sidewalk: mk(sidewalk()),
    plaza: mk(plaza()),
    grass: mk(grass()),
    gravel: mk(gravel()),
    roofTile: mk(roofTile()),
    roofFlat: mk(roofFlat()),
    hedge: mk(hedge()),
    wood: mk(wood()),
    stone: mk(stone()),
    sand: mk(sand()),
    rubber: mk(rubber()),
    waterNormal: mk(waterNormal(), { srgb: false }),
    softCircle: mk(softCircle(), { repeat: false }),
    beam: mk(beam(), { repeat: false }),
    chevron: mk(chevron(), { repeat: false }),
  };
  return {
    ...t,
    dispose() {
      for (const k of Object.keys(t) as (keyof typeof t)[]) t[k].dispose();
    },
  };
}

export { shade, hexToRgb };
