import { useEffect, useRef, useState } from 'react';
import { publicLocations, type GameLocation } from '@pixels/shared';
import { runtime, useGame } from '../state';
import { gameClient } from '../net/client';
import { KEYS, safeGet, safeSet } from '../net/storage';
import { clampToCircle, getStaticLayer, PX_PER_M, viewToWorld, worldToView } from './minimapRender';
import { nameColor } from './format';
import { IconMinus, IconPlus } from './icons';
import { WORLD_BOUNDS } from '@pixels/shared';

const SIZE = 184; // CSS px
const FPS_MS = 1000 / 15;
const ZOOMS = [28, 45, 75]; // visible radius in metres
const PIN_COLOR: Record<GameLocation['kind'], string> = { shop: '#fbbf24', building: '#f1f5f9', landmark: '#93c5fd', park: '#86efac' };

interface PinHit {
  id: string;
  name: string;
  x: number;
  y: number;
}

export default function Minimap() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pinsRef = useRef<PinHit[]>([]);
  const [northUp, setNorthUp] = useState(() => safeGet(KEYS.minimapNorthUp) === '1');
  const [zoom, setZoom] = useState(() => {
    const z = Number(safeGet(KEYS.minimapZoom));
    return Number.isInteger(z) && z >= 0 && z < ZOOMS.length ? z : 1;
  });
  const [hover, setHover] = useState<string | null>(null);
  const viewRef = useRef({ northUp, zoom });
  viewRef.current = { northUp, zoom };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    const locations = publicLocations();
    const layer = getStaticLayer();
    let raf = 0;
    let last = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < FPS_MS) return;
      last = now;
      const { northUp: nu, zoom: zi } = viewRef.current;
      const R = SIZE / 2;
      const radius = ZOOMS[zi];
      const k = (R - 3) / radius;
      const px = runtime.local.x;
      const pz = runtime.local.z;
      const rot = nu ? 0 : runtime.cameraYaw;
      const cx = R;
      const cy = R;
      const toView = (x: number, z: number) => worldToView(x, z, px, pz, rot, k, cx, cy);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R - 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = '#1e3a2c';
      ctx.fillRect(0, 0, SIZE, SIZE);

      // static world layer
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.scale(k / PX_PER_M, k / PX_PER_M);
      ctx.translate(-(px - WORLD_BOUNDS.minX) * PX_PER_M, -(pz - WORLD_BOUNDS.minZ) * PX_PER_M);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(layer, 0, 0);
      ctx.restore();

      // auto-walk path
      const nav = runtime.navPath;
      if (nav && nav.points.length) {
        ctx.beginPath();
        const s = toView(px, pz);
        ctx.moveTo(s.x, s.y);
        for (const p of nav.points) {
          const v = toView(p.x, p.z);
          ctx.lineTo(v.x, v.y);
        }
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(15,23,42,0.55)';
        ctx.setLineDash([]);
        ctx.stroke();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#22d3ee';
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // location pins
      const hits: PinHit[] = [];
      for (const loc of locations) {
        const v = toView(loc.x, loc.z);
        const dist = Math.hypot(v.x - cx, v.y - cy);
        const isShop = loc.kind === 'shop';
        if (dist > R - 6 && !isShop) continue;
        const p = isShop ? clampToCircle(v.x, v.y, cx, cy, R - 9) : { x: v.x, y: v.y };
        ctx.beginPath();
        ctx.arc(p.x, p.y, isShop ? 5.5 : 3.6, 0, Math.PI * 2);
        ctx.fillStyle = PIN_COLOR[loc.kind];
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = 'rgba(15,23,42,0.85)';
        ctx.stroke();
        hits.push({ id: loc.id, name: loc.name, x: p.x, y: p.y });
      }
      pinsRef.current = hits;

      // mission objective pulse (clamped to the rim when off the map)
      const mission = useGame.getState().mission;
      const obj = mission ? mission.objectives[Math.min(mission.current, mission.objectives.length - 1)] : null;
      if (obj && !obj.done) {
        const v = toView(obj.x, obj.z);
        const p = clampToCircle(v.x, v.y, cx, cy, R - 10);
        const t = (now % 1400) / 1400;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5 + t * 11, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(251,191,36,${(1 - t) * 0.9})`;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.clamped ? 4 : 5, 0, Math.PI * 2);
        ctx.fillStyle = '#fbbf24';
        ctx.fill();
        ctx.lineWidth = 1.8;
        ctx.strokeStyle = '#7c2d12';
        ctx.stroke();
      }

      // other players
      for (const r of runtime.remotes.values()) {
        const v = toView(r.x, r.z);
        if (Math.hypot(v.x - cx, v.y - cy) > R - 5) continue;
        ctx.beginPath();
        ctx.arc(v.x, v.y, 3.4, 0, Math.PI * 2);
        ctx.fillStyle = nameColor(r.name);
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = 'rgba(15,23,42,0.9)';
        ctx.stroke();
      }

      // local player arrow (heading = ry; forward is (sin ry, cos ry); "up" on screen is ry = PI)
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot + Math.PI - runtime.local.ry);
      ctx.beginPath();
      ctx.moveTo(0, -8);
      ctx.lineTo(5.6, 6);
      ctx.lineTo(0, 3);
      ctx.lineTo(-5.6, 6);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = '#0f172a';
      ctx.stroke();
      ctx.restore();
      ctx.restore();

      // rim + north marker
      ctx.beginPath();
      ctx.arc(cx, cy, R - 2, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.stroke();
      const nx = Math.sin(rot);
      const ny = -Math.cos(rot);
      const nxp = cx + nx * (R - 11);
      const nyp = cy + ny * (R - 11);
      ctx.beginPath();
      ctx.arc(nxp, nyp, 8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(15,23,42,0.85)';
      ctx.fill();
      ctx.fillStyle = '#fca5a5';
      ctx.font = '700 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('N', nxp, nyp + 0.5);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const pinAt = (e: { clientX: number; clientY: number }): PinHit | null => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = ((e.clientX - rect.left) / rect.width) * SIZE;
    const y = ((e.clientY - rect.top) / rect.height) * SIZE;
    let best: PinHit | null = null;
    let bd = 11;
    for (const p of pinsRef.current) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  };

  const setView = (nu: boolean, z: number) => {
    setNorthUp(nu);
    setZoom(z);
    safeSet(KEYS.minimapNorthUp, nu ? '1' : '0');
    safeSet(KEYS.minimapZoom, String(z));
  };

  return (
    <section className="minimap" aria-label="Minimap">
      <div className="minimap-frame">
        <canvas
          ref={canvasRef}
          className="minimap-canvas"
          style={{ width: SIZE, height: SIZE, cursor: hover ? 'pointer' : 'default' }}
          role="img"
          aria-label="Town minimap. Click a location pin to walk there."
          onPointerMove={(e) => {
            const h = pinAt(e);
            setHover(h ? h.name : null);
          }}
          onPointerLeave={() => setHover(null)}
          onClick={(e) => {
            const h = pinAt(e);
            if (h) gameClient.navigateTo(h.id);
          }}
        />
        <div className="minimap-tools">
          <button type="button" className={`mm-btn${northUp ? ' is-on' : ''}`} aria-pressed={northUp} title={northUp ? 'North is up (click for heading-up)' : 'Map turns with the camera (click for north-up)'} onClick={() => setView(!northUp, zoom)}>
            N
          </button>
          <button type="button" className="mm-btn" aria-label="Zoom map in" disabled={zoom === 0} onClick={() => setView(northUp, Math.max(0, zoom - 1))}>
            <IconPlus size={12} />
          </button>
          <button type="button" className="mm-btn" aria-label="Zoom map out" disabled={zoom === ZOOMS.length - 1} onClick={() => setView(northUp, Math.min(ZOOMS.length - 1, zoom + 1))}>
            <IconMinus size={12} />
          </button>
        </div>
      </div>
      <div className="minimap-caption" aria-live="polite">
        {hover ? `${hover} · click to walk` : 'Click a pin to walk there'}
      </div>
    </section>
  );
}
