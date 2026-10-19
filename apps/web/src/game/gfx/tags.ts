import * as THREE from 'three';
import { FONT_STACK, makeCanvas, roundRect } from './canvasUtil';

/** Canvas-texture name tags and chat bubbles (rendered as camera facing sprites). */
const nameCache = new Map<string, { tex: THREE.CanvasTexture; aspect: number; refs: number }>();

export function acquireNameTexture(name: string): { tex: THREE.CanvasTexture; aspect: number } {
  let e = nameCache.get(name);
  if (!e) {
    const H = 96;
    const { canvas: probe, ctx: pctx } = makeCanvas(8, 8);
    pctx.font = `700 52px ${FONT_STACK}`;
    const tw = Math.min(900, Math.ceil(pctx.measureText(name).width));
    void probe;
    const W = Math.max(160, tw + 64);
    const { canvas, ctx } = makeCanvas(W, H);
    ctx.fillStyle = 'rgba(14,18,28,0.62)';
    roundRect(ctx, 4, 8, W - 8, H - 16, 26);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = `700 52px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 6;
    ctx.strokeText(name, W / 2, H / 2 + 2, W - 40);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(name, W / 2, H / 2 + 2, W - 40);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    e = { tex, aspect: W / H, refs: 0 };
    nameCache.set(name, e);
  }
  e.refs++;
  return e;
}
export function releaseNameTexture(name: string): void {
  const e = nameCache.get(name);
  if (!e) return;
  if (--e.refs <= 0) {
    e.tex.dispose();
    nameCache.delete(name);
  }
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(test).width <= maxW || !cur) {
      cur = test;
      // hard-break very long words
      while (ctx.measureText(cur).width > maxW && cur.length > 1) {
        let cut = cur.length - 1;
        while (cut > 1 && ctx.measureText(cur.slice(0, cut)).width > maxW) cut--;
        lines.push(cur.slice(0, cut));
        cur = cur.slice(cut);
      }
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,2}$/, '…');
  }
  return lines;
}

/** Draw a chat bubble into `canvas` (fixed size 512x256, bubble anchored bottom centre). */
export function drawBubble(canvas: HTMLCanvasElement, text: string): void {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.font = `600 34px ${FONT_STACK}`;
  const lines = wrapLines(ctx, text, 400, 4);
  const lh = 42;
  let tw = 0;
  for (const l of lines) tw = Math.max(tw, ctx.measureText(l).width);
  const bw = Math.min(W - 16, tw + 56);
  const bh = lines.length * lh + 34;
  const x = (W - bw) / 2;
  const y = H - 40 - bh;
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.strokeStyle = 'rgba(20,24,36,0.55)';
  ctx.lineWidth = 3;
  roundRect(ctx, x, y, bw, bh, 22);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(W / 2 - 14, y + bh - 1);
  ctx.lineTo(W / 2, y + bh + 26);
  ctx.lineTo(W / 2 + 14, y + bh - 1);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.fill();
  ctx.fillStyle = '#1b2030';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, W / 2, y + 17 + lh / 2 + i * lh));
}
