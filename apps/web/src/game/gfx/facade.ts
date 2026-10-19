import * as THREE from 'three';
import type { Building } from '@pixels/shared';
import { FONT_STACK, SERIF_STACK, fbm, fitText, hexToRgb, makeCanvas, mixHex, mulberry32, paintNoise, roundRect, shade, toTexture } from './canvasUtil';

/**
 * Painted building walls. Each wall is rendered into a colour canvas and a (half resolution) emissive canvas that holds
 * the lit windows / shop glass for night time. Layout maths is exported for the 3D builder (door placement etc).
 */

export interface KindStyle {
  wall: 'brick' | 'plaster' | 'stone';
  trim: string;
  gfH: number;
  floorH: number;
  bayW: number;
  winW: number;
  winStyle: 'rect' | 'arched' | 'tall';
  shutters?: string;
  flowers?: boolean;
  balconies?: boolean;
  neon?: boolean;
  stringCourse: boolean;
  doorW: number;
  doorH: number;
}

export const STYLES: Record<Building['kind'], KindStyle> = {
  apartments: { wall: 'brick', trim: '#e9e2d3', gfH: 3.4, floorH: 2.9, bayW: 3.0, winW: 1.2, winStyle: 'rect', balconies: true, stringCourse: true, doorW: 1.9, doorH: 2.6 },
  bakery: { wall: 'plaster', trim: '#fbf3e2', gfH: 3.8, floorH: 3.4, bayW: 3.4, winW: 1.4, winStyle: 'rect', shutters: '#6f8f5a', flowers: true, stringCourse: false, doorW: 1.6, doorH: 2.5 },
  shop: { wall: 'plaster', trim: '#f2f6f4', gfH: 4.0, floorH: 2.6, bayW: 3.2, winW: 1.4, winStyle: 'rect', stringCourse: true, doorW: 1.7, doorH: 2.6 },
  cafe: { wall: 'plaster', trim: '#f4e8d6', gfH: 3.5, floorH: 3.5, bayW: 3.5, winW: 1.3, winStyle: 'rect', shutters: '#3e5b4a', flowers: true, stringCourse: false, doorW: 1.6, doorH: 2.5 },
  hall: { wall: 'stone', trim: '#f5f1e6', gfH: 4.6, floorH: 3.2, bayW: 3.6, winW: 1.3, winStyle: 'tall', stringCourse: true, doorW: 2.4, doorH: 3.2 },
  library: { wall: 'brick', trim: '#e6dccb', gfH: 4.2, floorH: 3.5, bayW: 3.8, winW: 1.4, winStyle: 'arched', stringCourse: true, doorW: 2.2, doorH: 3.0 },
  post: { wall: 'plaster', trim: '#fdf6f0', gfH: 3.6, floorH: 3.4, bayW: 3.4, winW: 1.4, winStyle: 'rect', stringCourse: true, doorW: 1.7, doorH: 2.6 },
  arcade: { wall: 'plaster', trim: '#2b2350', gfH: 3.8, floorH: 3.1, bayW: 3.3, winW: 1.5, winStyle: 'rect', neon: true, stringCourse: false, doorW: 1.9, doorH: 2.6 },
};

export interface WallLayout {
  gfH: number;
  floors: number;
  floorH: number;
  bays: number;
  bayW: number;
  winW: number;
  winH: number;
}

export function wallLayout(kind: Building['kind'], widthM: number, heightM: number): WallLayout {
  const st = STYLES[kind];
  const upper = Math.max(1, Math.round((heightM - st.gfH) / st.floorH));
  const floorH = (heightM - st.gfH) / upper;
  const bays = Math.max(2, Math.round(widthM / st.bayW));
  const bayW = widthM / bays;
  const winW = Math.min(st.winW, bayW * 0.55);
  const winH = Math.max(1.25, Math.min(floorH * 0.58, st.winStyle === 'rect' ? 1.8 : 2.4));
  return { gfH: st.gfH, floors: upper, floorH, bays, bayW, winW, winH };
}

export interface WallSpec {
  kind: Building['kind'];
  color: string;
  widthM: number;
  heightM: number;
  ppm: number;
  face: 'front' | 'side' | 'back';
  /** x offset of the door centre from the wall centre (front only) */
  doorX: number;
  /** x ranges (relative to wall centre) that must stay plain, e.g. behind the shop kiosk */
  seed: number;
}

export interface PaintedWall {
  map: HTMLCanvasElement;
  emissive: HTMLCanvasElement;
}

const GLASS_TOP = '#7ea4c2';
const GLASS_BOT = '#3f5d74';

function paintBase(ctx: CanvasRenderingContext2D, W: number, H: number, st: KindStyle, color: string, P: number, rng: () => number): void {
  const base = hexToRgb(color);
  const N = 256;
  const { canvas: tmp, ctx: tctx } = makeCanvas(N, N);
  paintNoise(tctx, N, base, fbm(N, 6, 4, rng), st.wall === 'plaster' ? 0.16 : 0.22, st.wall === 'plaster' ? 0.07 : 0.12, rng);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmp, 0, 0, W, H);
  if (st.wall === 'brick') {
    const bh = 0.17 * P;
    const bw = 0.42 * P;
    for (let r = 0; r * bh < H; r++) {
      const y = r * bh;
      const off = (r % 2) * bw * 0.5;
      for (let x = -off; x < W; x += bw) {
        const k = (rng() - 0.5) * 0.22;
        ctx.fillStyle = k > 0 ? `rgba(255,235,210,${k})` : `rgba(30,10,0,${-k})`;
        ctx.fillRect(x + 1, y + 1, bw - 1, bh - 1);
      }
      ctx.fillStyle = 'rgba(235,225,205,0.5)';
      ctx.fillRect(0, y, W, Math.max(1, P * 0.025));
      for (let x = -off; x < W; x += bw) ctx.fillRect(x, y, Math.max(1, P * 0.025), bh);
    }
  } else if (st.wall === 'stone') {
    const bh = 0.5 * P;
    const bw = 1.1 * P;
    for (let r = 0; r * bh < H; r++) {
      const y = r * bh;
      const off = (r % 2) * bw * 0.5;
      for (let x = -off; x < W; x += bw) {
        const k = (rng() - 0.5) * 0.12;
        ctx.fillStyle = k > 0 ? `rgba(255,255,255,${k})` : `rgba(40,30,10,${-k})`;
        ctx.fillRect(x + 1, y + 1, bw - 2, bh - 2);
      }
      ctx.fillStyle = 'rgba(90,80,60,0.35)';
      ctx.fillRect(0, y, W, Math.max(1, P * 0.03));
      for (let x = -off; x < W; x += bw) ctx.fillRect(x, y, Math.max(1, P * 0.03), bh);
    }
  } else {
    // stucco streaks
    for (let i = 0; i < W * H / 900; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(60,40,20,0.05)';
      ctx.fillRect(rng() * W, rng() * H, 4 + rng() * 22, 1 + rng() * 3);
    }
  }
  // plinth
  const pl = 0.55 * P;
  ctx.fillStyle = shade(color, 0.62);
  ctx.fillRect(0, H - pl, W, pl);
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(0, H - pl, W, 2);
}

function paintCornice(ctx: CanvasRenderingContext2D, W: number, H: number, st: KindStyle, P: number): void {
  const c = 0.38 * P;
  ctx.fillStyle = st.trim;
  ctx.fillRect(0, 0, W, c);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fillRect(0, c, W, Math.max(2, 0.06 * P));
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillRect(0, 0, W, 2);
  // dentils
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  for (let x = 0; x < W; x += 0.35 * P) ctx.fillRect(x, c * 0.55, 0.16 * P, c * 0.4);
  void H;
}

function paintStringCourse(ctx: CanvasRenderingContext2D, W: number, y: number, st: KindStyle, P: number): void {
  const h = 0.22 * P;
  ctx.fillStyle = st.trim;
  ctx.fillRect(0, y - h / 2, W, h);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(0, y + h / 2, W, Math.max(2, 0.05 * P));
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillRect(0, y - h / 2, W, 1.5);
}

interface WinOpts {
  style: 'rect' | 'arched' | 'tall';
  lit: boolean;
  shutters?: string;
  flowers?: boolean;
  balcony?: boolean;
  trim: string;
  curtain: boolean;
  neon?: boolean;
  litColor: string;
}

function glassPath(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, arched: boolean): void {
  c.beginPath();
  if (arched) {
    c.moveTo(x, y + h);
    c.lineTo(x, y + w / 2);
    c.arc(x + w / 2, y + w / 2, w / 2, Math.PI, 0);
    c.lineTo(x + w, y + h);
  } else {
    c.rect(x, y, w, h);
  }
  c.closePath();
}

/** Paint one window (x,y = top-left) into both colour and emissive contexts. */
function paintWindow(ctx: CanvasRenderingContext2D, ectx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, P: number, o: WinOpts): void {
  const arched = o.style === 'arched';
  const fr = Math.max(2, 0.09 * P);
  // surround / lintel
  ctx.fillStyle = o.trim;
  if (arched) {
    glassPath(ctx, x - fr * 1.6, y - fr * 1.6, w + fr * 3.2, h + fr * 1.6, true);
    ctx.fill();
  } else {
    ctx.fillRect(x - fr * 1.5, y - fr * 2.2, w + fr * 3, h + fr * 2.2);
  }
  // shutters
  if (o.shutters) {
    ctx.fillStyle = o.shutters;
    const sw = w * 0.42;
    ctx.fillRect(x - fr * 1.5 - sw, y - fr, sw, h + fr);
    ctx.fillRect(x + w + fr * 1.5, y - fr, sw, h + fr);
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 1;
    for (let s = 0; s < h; s += 0.14 * P) {
      ctx.beginPath(); ctx.moveTo(x - fr * 1.5 - sw, y - fr + s); ctx.lineTo(x - fr * 1.5, y - fr + s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + w + fr * 1.5, y - fr + s); ctx.lineTo(x + w + fr * 1.5 + sw, y - fr + s); ctx.stroke();
    }
  }
  // frame
  ctx.fillStyle = shade(o.trim, 0.78);
  glassPath(ctx, x - fr, y - fr, w + fr * 2, h + fr, arched);
  ctx.fill();
  // glass
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, GLASS_TOP);
  g.addColorStop(1, GLASS_BOT);
  ctx.fillStyle = g;
  glassPath(ctx, x, y, w, h, arched);
  ctx.fill();
  ctx.save();
  glassPath(ctx, x, y, w, h, arched);
  ctx.clip();
  if (o.curtain) {
    ctx.fillStyle = 'rgba(236,224,196,0.82)';
    ctx.fillRect(x, y, w, h * 0.55);
    ctx.fillStyle = 'rgba(180,150,110,0.45)';
    for (let k = 1; k < 5; k++) ctx.fillRect(x + (w * k) / 5, y, 1.5, h * 0.55);
  }
  // reflection streaks
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.beginPath();
  ctx.moveTo(x + w * 0.1, y + h);
  ctx.lineTo(x + w * 0.45, y);
  ctx.lineTo(x + w * 0.62, y);
  ctx.lineTo(x + w * 0.27, y + h);
  ctx.closePath();
  ctx.fill();
  // inner shadow
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(x, y, w, Math.max(2, h * 0.07));
  ctx.fillRect(x, y, Math.max(2, w * 0.05), h);
  ctx.restore();
  // mullions
  ctx.strokeStyle = shade(o.trim, 0.9);
  ctx.lineWidth = Math.max(1.5, 0.045 * P);
  ctx.beginPath();
  ctx.moveTo(x + w / 2, y);
  ctx.lineTo(x + w / 2, y + h);
  ctx.moveTo(x, y + h * 0.5);
  ctx.lineTo(x + w, y + h * 0.5);
  ctx.stroke();
  // sill
  ctx.fillStyle = o.trim;
  ctx.fillRect(x - fr * 2, y + h, w + fr * 4, fr * 1.6);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(x - fr * 2, y + h + fr * 1.6, w + fr * 4, Math.max(2, fr * 0.7));
  // flower box
  if (o.flowers) {
    ctx.fillStyle = '#6b4a2f';
    ctx.fillRect(x - fr, y + h + fr * 1.6, w + fr * 2, fr * 2.4);
    const cols = ['#e5566d', '#f4c542', '#f78fb3', '#ffffff', '#b97bd6'];
    for (let k = 0; k < 9; k++) {
      ctx.fillStyle = k % 3 === 0 ? '#3f8f3a' : cols[k % cols.length];
      ctx.beginPath();
      ctx.arc(x - fr + ((w + fr * 2) * (k + 0.5)) / 9, y + h + fr * 1.4, fr * 0.95, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (o.balcony) {
    const by = y + h + fr * 1.6;
    ctx.fillStyle = '#d8d1c2';
    ctx.fillRect(x - w * 0.35, by, w * 1.7, fr * 1.3);
    ctx.strokeStyle = '#2d2d33';
    ctx.lineWidth = Math.max(1, 0.03 * P);
    const rh = 0.9 * P * 0.6;
    ctx.strokeRect(x - w * 0.35, by - rh, w * 1.7, rh);
    for (let k = 0; k <= 8; k++) {
      const px = x - w * 0.35 + (w * 1.7 * k) / 8;
      ctx.beginPath(); ctx.moveTo(px, by - rh); ctx.lineTo(px, by); ctx.stroke();
    }
  }
  if (o.neon) {
    ctx.strokeStyle = 'rgba(255,90,220,0.9)';
    ctx.lineWidth = Math.max(2, 0.06 * P);
    ctx.strokeRect(x - fr * 2.2, y - fr * 2.2, w + fr * 4.4, h + fr * 4.4);
    ectx.strokeStyle = 'rgba(255,60,210,1)';
    ectx.lineWidth = Math.max(2, 0.08 * P);
    ectx.strokeRect(x - fr * 2.2, y - fr * 2.2, w + fr * 4.4, h + fr * 4.4);
  }
  if (o.lit) {
    ectx.save();
    glassPath(ectx, x, y, w, h, arched);
    ectx.clip();
    const eg = ectx.createLinearGradient(x, y, x, y + h);
    eg.addColorStop(0, o.litColor);
    eg.addColorStop(1, mixHex('#ffffff', o.litColor, 0.7));
    ectx.fillStyle = eg;
    ectx.fillRect(x, y, w, h);
    if (o.curtain) {
      ectx.fillStyle = 'rgba(0,0,0,0.25)';
      ectx.fillRect(x, y, w, h * 0.5);
    }
    ectx.fillStyle = 'rgba(0,0,0,0.9)';
    ectx.fillRect(x + w / 2 - Math.max(1, 0.025 * P), y, Math.max(2, 0.05 * P), h);
    ectx.fillRect(x, y + h * 0.5 - Math.max(1, 0.025 * P), w, Math.max(2, 0.05 * P));
    ectx.restore();
  }
}

const LIT_COLORS = ['#ffd9a0', '#ffe3b5', '#ffcf85', '#fff0d0', '#ffd08a', '#cfe1ff'];

/** Interior glow + goods behind a shop window (colour canvas: dim interior; emissive canvas: warm light). */
function paintShopGlass(
  ctx: CanvasRenderingContext2D, ectx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, P: number,
  kind: Building['kind'], rng: () => number, trim: string,
): void {
  const fr = Math.max(3, 0.1 * P);
  ctx.fillStyle = shade(trim, 0.75);
  ctx.fillRect(x - fr, y - fr, w + fr * 2, h + fr * 2);
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, '#86a9c4');
  g.addColorStop(0.55, '#4b6a82');
  g.addColorStop(1, '#2f4658');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  const interior = kind === 'arcade' ? ['#ff4fd8', '#41e9ff', '#8a5cff'] : kind === 'bakery' ? ['#c98a4a', '#e0b070', '#a9652f', '#f1d9a8'] : kind === 'cafe' ? ['#a8744a', '#e8d4b4', '#6b4a2f'] : ['#d9553f', '#f2b134', '#4fa35b', '#5a8fd0', '#e8e4dc'];
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ectx.save();
  ectx.beginPath(); ectx.rect(x, y, w, h); ectx.clip();
  const eg = ectx.createLinearGradient(x, y, x, y + h);
  const warm = kind === 'arcade' ? ['#7b2bd6', '#c93bd6'] : kind === 'cafe' ? ['#ffcf8a', '#ffb25c'] : ['#ffe3a6', '#ffbd62'];
  eg.addColorStop(0, warm[0]);
  eg.addColorStop(1, warm[1]);
  ectx.fillStyle = eg;
  ectx.fillRect(x, y, w, h);
  // shelves + goods
  const shelves = Math.max(2, Math.round(h / (0.62 * P)));
  for (let s = 0; s < shelves; s++) {
    const sy = y + ((s + 1) * h) / (shelves + 0.35);
    ctx.fillStyle = 'rgba(40,26,14,0.7)';
    ctx.fillRect(x, sy, w, Math.max(2, 0.05 * P));
    ectx.fillStyle = 'rgba(40,20,0,0.75)';
    ectx.fillRect(x, sy, w, Math.max(2, 0.06 * P));
    for (let gx = x + 0.15 * P; gx < x + w - 0.2 * P; gx += (0.22 + rng() * 0.3) * P) {
      const c = interior[Math.floor(rng() * interior.length)];
      const gw = (0.12 + rng() * 0.16) * P;
      const gh = (0.1 + rng() * 0.2) * P;
      ctx.fillStyle = c;
      ectx.fillStyle = shade(c, 0.9);
      if (kind === 'bakery' || kind === 'cafe') {
        ctx.beginPath(); ctx.ellipse(gx, sy - gh * 0.5, gw * 0.9, gh * 0.5, 0, 0, Math.PI * 2); ctx.fill();
        ectx.beginPath(); ectx.ellipse(gx, sy - gh * 0.5, gw * 0.9, gh * 0.5, 0, 0, Math.PI * 2); ectx.fill();
      } else {
        ctx.fillRect(gx, sy - gh, gw, gh);
        ectx.fillRect(gx, sy - gh, gw, gh);
      }
    }
  }
  // reflection
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.beginPath();
  ctx.moveTo(x + w * 0.05, y + h);
  ctx.lineTo(x + w * 0.38, y);
  ctx.lineTo(x + w * 0.52, y);
  ctx.lineTo(x + w * 0.19, y + h);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ectx.restore();
  // mullion
  ctx.fillStyle = shade(trim, 0.7);
  ctx.fillRect(x + w / 2 - fr / 2, y, fr, h);
  ectx.fillStyle = '#000';
  ectx.fillRect(x + w / 2 - fr / 2, y, fr, h);
  ctx.fillStyle = shade(trim, 0.85);
  ctx.fillRect(x - fr * 1.4, y + h + fr, w + fr * 2.8, fr * 1.5);
}

export function paintWall(spec: WallSpec): PaintedWall {
  const st = STYLES[spec.kind];
  const P = spec.ppm;
  const W = Math.round(spec.widthM * P);
  const H = Math.round(spec.heightM * P);
  const rng = mulberry32(spec.seed);
  const { canvas, ctx } = makeCanvas(W, H);
  const { canvas: ecanvas, ctx: ectx } = makeCanvas(W / 2, H / 2);
  ectx.scale(0.5, 0.5);
  ectx.fillStyle = '#000';
  ectx.fillRect(0, 0, W, H);

  paintBase(ctx, W, H, st, spec.color, P, rng);
  const L = wallLayout(spec.kind, spec.widthM, spec.heightM);
  const cx = W / 2;
  const front = spec.face === 'front';
  const topY = (yFromGround: number) => H - yFromGround * P;

  // string courses at floor lines
  if (st.stringCourse) {
    paintStringCourse(ctx, W, topY(L.gfH), st, P);
    if (spec.kind === 'apartments' || spec.kind === 'hall') for (let f = 1; f < L.floors; f++) paintStringCourse(ctx, W, topY(L.gfH + f * L.floorH), st, P);
  }
  paintCornice(ctx, W, H, st, P);

  const winOpts = (f: number, i: number): WinOpts => ({
    style: st.winStyle,
    lit: rng() < 0.56,
    shutters: st.shutters,
    flowers: st.flowers && f === 0,
    balcony: st.balconies && f > 0 && (i + f) % 2 === 0,
    trim: st.trim,
    curtain: rng() < 0.4,
    neon: st.neon,
    litColor: LIT_COLORS[Math.floor(rng() * LIT_COLORS.length)],
  });

  // upper floors
  for (let f = 0; f < L.floors; f++) {
    const centerY = L.gfH + (f + 0.5) * L.floorH;
    const wy = topY(centerY + L.winH / 2 - (st.winStyle === 'rect' ? 0 : 0.0));
    for (let i = 0; i < L.bays; i++) {
      const wx = ((i + 0.5) * L.bayW - L.winW / 2) * P;
      paintWindow(ctx, ectx, wx, wy, L.winW * P, L.winH * P, P, winOpts(f, i));
    }
  }

  // ground floor
  if (front) {
    const doorCx = cx + spec.doorX * P;
    const doorHalf = (st.doorW / 2 + 0.25) * P;
    const glassBottom = 0.6;
    const glassTop = L.gfH - (spec.kind === 'hall' || spec.kind === 'library' ? 1.1 : 1.35);
    if (spec.kind === 'hall' || spec.kind === 'library') {
      // tall arched ground windows either side of the portal
      const style: 'arched' | 'tall' = spec.kind === 'library' ? 'arched' : 'tall';
      const gw = 1.5;
      const slots: number[] = [];
      for (let i = 0; i < L.bays; i++) {
        const x = (i + 0.5) * L.bayW * P;
        if (Math.abs(x - doorCx) > doorHalf + (gw / 2 + 0.6) * P) slots.push(x);
      }
      for (const x of slots) paintWindow(ctx, ectx, x - (gw / 2) * P, topY(glassTop), gw * P, (glassTop - 0.9) * P, P, { ...winOpts(0, 0), style, lit: true, curtain: false, flowers: false, litColor: '#ffd9a0' });
    } else if (spec.kind === 'apartments') {
      // small windows either side of the entrance
      for (let i = 0; i < L.bays; i++) {
        const x = (i + 0.5) * L.bayW * P;
        if (Math.abs(x - doorCx) > doorHalf + 0.9 * P) paintWindow(ctx, ectx, x - (L.winW / 2) * P, topY(2.55), L.winW * P, 1.35 * P, P, winOpts(0, i));
      }
    } else {
      // shopfront glass on both sides of the door
      const margin = 0.9 * P;
      const spans: [number, number][] = [
        [margin, doorCx - doorHalf - 0.2 * P],
        [doorCx + doorHalf + 0.2 * P, W - margin],
      ];
      for (const [a, b] of spans) {
        const total = b - a;
        if (total < 1.2 * P) continue;
        const panes = Math.max(1, Math.round(total / (3.4 * P)));
        const gap = 0.14 * P;
        const pw = (total - gap * (panes - 1)) / panes;
        for (let p = 0; p < panes; p++) {
          paintShopGlass(ctx, ectx, a + p * (pw + gap), topY(glassTop), pw, (glassTop - glassBottom) * P, P, spec.kind, rng, st.trim);
        }
      }
      if (spec.kind === 'cafe') {
        // chalkboard menu beside the door
        const bx = doorCx + doorHalf + 0.3 * P;
        void bx;
      }
    }
    // stoop shadow line under sign band & threshold
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, topY(L.gfH) + 2, W, Math.max(3, 0.12 * P));
  } else {
    // side/back: ground floor windows continue the grid, smaller
    for (let i = 0; i < L.bays; i++) {
      const wx = ((i + 0.5) * L.bayW - L.winW / 2) * P;
      const wy = topY(2.7);
      if (spec.kind === 'apartments' || spec.kind === 'hall' || spec.kind === 'library' || spec.kind === 'post' || spec.kind === 'cafe' || spec.kind === 'bakery' || spec.kind === 'shop' || spec.kind === 'arcade')
        paintWindow(ctx, ectx, wx, wy, L.winW * P, 1.5 * P, P, { ...winOpts(0, i), balcony: false, flowers: false });
    }
  }

  // grime at the bottom
  const gr = ctx.createLinearGradient(0, H - 1.6 * P, 0, H);
  gr.addColorStop(0, 'rgba(30,25,15,0)');
  gr.addColorStop(1, 'rgba(30,25,15,0.28)');
  ctx.fillStyle = gr;
  ctx.fillRect(0, H - 1.6 * P, W, 1.6 * P);

  return { map: canvas, emissive: ecanvas };
}

export interface SignStyle {
  bg: string;
  bg2: string;
  fg: string;
  accent: string;
  font: string;
  neon?: boolean;
  border: string;
}
export const SIGN_STYLES: Record<Building['kind'], SignStyle> = {
  bakery: { bg: '#f6e9cf', bg2: '#e6cfa4', fg: '#6a3b1e', accent: '#c98a3a', font: SERIF_STACK, border: '#7a4a24' },
  shop: { bg: '#1f6f78', bg2: '#17535b', fg: '#ffffff', accent: '#ffd45a', font: FONT_STACK, border: '#f2f6f4' },
  cafe: { bg: '#2f4a3b', bg2: '#243a2e', fg: '#f6ead3', accent: '#d9a066', font: SERIF_STACK, border: '#d9a066' },
  hall: { bg: '#ddd5c2', bg2: '#c8bea7', fg: '#3b352b', accent: '#7b2d26', font: SERIF_STACK, border: '#7b2d26' },
  library: { bg: '#3b2a22', bg2: '#2a1d17', fg: '#e8c982', accent: '#e8c982', font: SERIF_STACK, border: '#c9a95f' },
  post: { bg: '#c93a3a', bg2: '#a82b2b', fg: '#ffffff', accent: '#ffe27a', font: FONT_STACK, border: '#ffffff' },
  arcade: { bg: '#120d26', bg2: '#0a0716', fg: '#7df9ff', accent: '#ff4fd8', font: "'Impact','Arial Black','Trebuchet MS',sans-serif", neon: true, border: '#ff4fd8' },
  apartments: { bg: '#d8d1c2', bg2: '#bfb7a5', fg: '#3b352b', accent: '#7a5a3a', font: SERIF_STACK, border: '#7a5a3a' },
};

function drawIcon(ctx: CanvasRenderingContext2D, kind: Building['kind'], x: number, y: number, s: number, color: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = s * 0.08;
  ctx.lineCap = 'round';
  switch (kind) {
    case 'bakery': // wheat ear
      ctx.beginPath(); ctx.moveTo(0, s * 0.5); ctx.lineTo(0, -s * 0.5); ctx.stroke();
      for (let i = 0; i < 4; i++) {
        for (const d of [-1, 1]) {
          ctx.beginPath(); ctx.ellipse(d * s * 0.16, -s * 0.38 + i * s * 0.2, s * 0.09, s * 0.17, d * 0.6, 0, Math.PI * 2); ctx.fill();
        }
      }
      break;
    case 'cafe': // cup
      ctx.beginPath(); ctx.moveTo(-s * 0.35, -s * 0.2); ctx.lineTo(s * 0.3, -s * 0.2); ctx.lineTo(s * 0.22, s * 0.35); ctx.lineTo(-s * 0.27, s * 0.35); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.arc(s * 0.36, 0, s * 0.16, -Math.PI / 2, Math.PI / 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-s * 0.15, -s * 0.34); ctx.quadraticCurveTo(-s * 0.05, -s * 0.5, -s * 0.15, -s * 0.62); ctx.stroke();
      break;
    case 'post': // envelope
      ctx.strokeStyle = color;
      ctx.strokeRect(-s * 0.45, -s * 0.28, s * 0.9, s * 0.56);
      ctx.beginPath(); ctx.moveTo(-s * 0.45, -s * 0.28); ctx.lineTo(0, s * 0.06); ctx.lineTo(s * 0.45, -s * 0.28); ctx.stroke();
      break;
    case 'library': // book
      ctx.beginPath(); ctx.moveTo(0, -s * 0.28); ctx.quadraticCurveTo(-s * 0.3, -s * 0.4, -s * 0.5, -s * 0.28); ctx.lineTo(-s * 0.5, s * 0.34); ctx.quadraticCurveTo(-s * 0.3, s * 0.22, 0, s * 0.34); ctx.quadraticCurveTo(s * 0.3, s * 0.22, s * 0.5, s * 0.34); ctx.lineTo(s * 0.5, -s * 0.28); ctx.quadraticCurveTo(s * 0.3, -s * 0.4, 0, -s * 0.28); ctx.stroke();
      break;
    case 'shop': // basket / bag
      ctx.beginPath(); ctx.moveTo(-s * 0.4, -s * 0.1); ctx.lineTo(s * 0.4, -s * 0.1); ctx.lineTo(s * 0.3, s * 0.4); ctx.lineTo(-s * 0.3, s * 0.4); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.arc(0, -s * 0.1, s * 0.22, Math.PI, 0); ctx.stroke();
      break;
    default:
      break;
  }
  ctx.restore();
}

/** Name sign: returns colour canvas + emissive canvas (same content: brightness is driven by emissiveIntensity). */
export function paintSign(name: string, kind: Building['kind']): { map: HTMLCanvasElement; emissive: HTMLCanvasElement } {
  const st = SIGN_STYLES[kind];
  const W = 1024;
  const H = 192;
  const { canvas, ctx } = makeCanvas(W, H);
  const { canvas: ecanvas, ctx: ectx } = makeCanvas(W / 2, H / 2);
  ectx.scale(0.5, 0.5);
  const hasIcon = ['bakery', 'cafe', 'post', 'library', 'shop'].includes(kind);
  if (st.neon) {
    ctx.fillStyle = '#0b0818';
    ctx.fillRect(0, 0, W, H);
    ectx.fillStyle = '#000';
    ectx.fillRect(0, 0, W, H);
    // neon tube border
    for (const c of [ctx, ectx]) {
      c.strokeStyle = st.border;
      c.lineWidth = 7;
      c.shadowColor = st.border;
      c.shadowBlur = 16;
      roundRect(c, 14, 14, W - 28, H - 28, 26);
      c.stroke();
      c.shadowBlur = 0;
    }
    for (const c of [ctx, ectx]) {
      c.fillStyle = '#ffffff';
      c.shadowColor = st.fg;
      c.shadowBlur = 22;
      c.font = `bold 96px ${st.font}`;
      let size = 96;
      c.font = `${size}px ${st.font}`;
      const w = c.measureText(name.toUpperCase()).width;
      if (w > W - 120) size = Math.floor((size * (W - 120)) / w);
      c.font = `${size}px ${st.font}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = st.fg;
      c.fillText(name.toUpperCase(), W / 2, H / 2 + 4);
      c.shadowBlur = 0;
    }
    return { map: canvas, emissive: ecanvas };
  }
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, st.bg);
  g.addColorStop(1, st.bg2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // border
  ctx.strokeStyle = st.border;
  ctx.lineWidth = 8;
  roundRect(ctx, 10, 10, W - 20, H - 20, 20);
  ctx.stroke();
  ctx.strokeStyle = st.accent;
  ctx.lineWidth = 3;
  roundRect(ctx, 22, 22, W - 44, H - 44, 14);
  ctx.stroke();
  ctx.fillStyle = st.fg;
  const textMax = hasIcon ? W - 300 : W - 120;
  const tx = hasIcon ? W / 2 + 70 : W / 2;
  fitText(ctx, name, tx, H / 2 + 4, textMax, 92, kind === 'hall' || kind === 'library' || kind === 'bakery' || kind === 'cafe' ? 'bold' : '800', st.font);
  if (hasIcon) drawIcon(ctx, kind, 120, H / 2, 96, st.accent);
  // emissive = same picture; slightly dimmed backdrop so text pops at night
  ectx.drawImage(canvas, 0, 0, W, H);
  return { map: canvas, emissive: ecanvas };
}

export function paintClockFace(): HTMLCanvasElement {
  const N = 256;
  const { canvas, ctx } = makeCanvas(N, N);
  ctx.fillStyle = '#d9d2bf';
  ctx.fillRect(0, 0, N, N);
  ctx.fillStyle = '#c8b27a';
  ctx.beginPath(); ctx.arc(N / 2, N / 2, N * 0.49, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f7f2e4';
  ctx.beginPath(); ctx.arc(N / 2, N / 2, N * 0.45, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#2b2620';
  ctx.lineWidth = 4;
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const big = i % 5 === 0;
    ctx.lineWidth = big ? 5 : 2;
    ctx.beginPath();
    ctx.moveTo(N / 2 + Math.sin(a) * N * (big ? 0.34 : 0.4), N / 2 - Math.cos(a) * N * (big ? 0.34 : 0.4));
    ctx.lineTo(N / 2 + Math.sin(a) * N * 0.43, N / 2 - Math.cos(a) * N * 0.43);
    ctx.stroke();
  }
  ctx.fillStyle = '#2b2620';
  ctx.font = `bold 26px ${SERIF_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 1; i <= 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.fillText(String(i), N / 2 + Math.sin(a) * N * 0.27, N / 2 - Math.cos(a) * N * 0.27);
  }
  return canvas;
}

export function wallTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  return toTexture(c, { repeat: false, aniso: 8 });
}
export function emissiveTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  return toTexture(c, { repeat: false, aniso: 4 });
}
