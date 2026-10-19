import * as THREE from 'three';
import { BUILDINGS, SHOP_COUNTER, SHOPKEEPER_POS, type Building } from '@pixels/shared';
import { GeoBuilder, setShadow, vcMaterial } from '../gfx/geo';
import { makeCanvas, shade, toTexture } from '../gfx/canvasUtil';
import { SIGN_STYLES, STYLES, emissiveTexture, paintClockFace, paintSign, paintWall, wallLayout, wallTexture } from '../gfx/facade';
import { createParticles } from '../gfx/particles';
import { mulberry32, hashString } from '../logic/palette';
import { SIDEWALK_H } from '../logic/layout';
import type { WorldCtx } from './ctx';

export interface BuildingsResult {
  root: THREE.Group;
  /** animated clock hands: call with time of day [0,1) */
  setClock(t: number): void;
}

/** Box with 4 material groups: 0 front(+z) 1 sides(+/-x) 2 back(-z) 3 top. UVs span each face 0..1. */
function wallGeometry(w: number, h: number, d: number): THREE.BufferGeometry {
  const hw = w / 2;
  const hd = d / 2;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const groups: { start: number; count: number; mat: number }[] = [];
  const face = (p: number[][], n: number[], mat: number) => {
    const base = pos.length / 3;
    const start = idx.length;
    const us = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (let i = 0; i < 4; i++) {
      pos.push(...p[i]);
      nor.push(...n);
      uv.push(...us[i]);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    groups.push({ start, count: 6, mat });
  };
  face([[-hw, 0, hd], [hw, 0, hd], [hw, h, hd], [-hw, h, hd]], [0, 0, 1], 0);
  face([[hw, 0, hd], [hw, 0, -hd], [hw, h, -hd], [hw, h, hd]], [1, 0, 0], 1);
  face([[-hw, 0, -hd], [-hw, 0, hd], [-hw, h, hd], [-hw, h, -hd]], [-1, 0, 0], 1);
  face([[hw, 0, -hd], [-hw, 0, -hd], [-hw, h, -hd], [hw, h, -hd]], [0, 0, -1], 2);
  face([[-hw, h, hd], [hw, h, hd], [hw, h, -hd], [-hw, h, -hd]], [0, 1, 0], 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  for (const gr of groups) g.addGroup(gr.start, gr.count, gr.mat);
  // merge consecutive groups with the same material index (sides)
  return g;
}

/** Planar-mapped polygon faces for roofs (all faces face up/outward). */
class RoofBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  face(pts: [number, number, number][], tile: number): void {
    const a = new THREE.Vector3(...pts[0]);
    const b = new THREE.Vector3(...pts[1]);
    const c = new THREE.Vector3(...pts[2]);
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    let list = pts;
    if (n.y < 0) {
      list = [...pts].reverse() as [number, number, number][];
      n.negate();
    }
    const t = new THREE.Vector3().subVectors(new THREE.Vector3(...list[1]), new THREE.Vector3(...list[0])).normalize();
    const bt = new THREE.Vector3().crossVectors(n, t).normalize();
    const o = new THREE.Vector3(...list[0]);
    const push = (p: [number, number, number]) => {
      const v = new THREE.Vector3(...p).sub(o);
      this.pos.push(...p);
      this.nor.push(n.x, n.y, n.z);
      this.uv.push(v.dot(t) / tile, v.dot(bt) / tile);
    };
    for (let i = 1; i < list.length - 1; i++) {
      push(list[0]);
      push(list[i]);
      push(list[i + 1]);
    }
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    return g;
  }
}

function roofGeometry(type: 'gable' | 'hip', w: number, d: number, h: number, rise: number, o: number): THREE.BufferGeometry {
  const rb = new RoofBuilder();
  const k = rise / (d / 2);
  const ey = h - k * o;
  const X = w / 2 + o;
  const Z = d / 2 + o;
  const y1 = h + rise;
  if (type === 'gable') {
    rb.face([[-X, ey, Z], [X, ey, Z], [X, y1, 0], [-X, y1, 0]], 2.5);
    rb.face([[X, ey, -Z], [-X, ey, -Z], [-X, y1, 0], [X, y1, 0]], 2.5);
  } else {
    const r = Math.max(0, w / 2 - d / 2);
    rb.face([[-X, ey, Z], [X, ey, Z], [r, y1, 0], [-r, y1, 0]], 2.5);
    rb.face([[X, ey, -Z], [-X, ey, -Z], [-r, y1, 0], [r, y1, 0]], 2.5);
    rb.face([[-X, ey, -Z], [-X, ey, Z], [-r, y1, 0]], 2.5);
    rb.face([[X, ey, Z], [X, ey, -Z], [r, y1, 0]], 2.5);
  }
  return rb.build();
}

const stripeCaches = new WeakMap<WorldCtx, Map<string, THREE.CanvasTexture>>();
function stripeTexture(ctx: WorldCtx, c1: string, c2: string): THREE.CanvasTexture {
  const key = c1 + c2;
  let stripeCache = stripeCaches.get(ctx);
  if (!stripeCache) {
    stripeCache = new Map();
    stripeCaches.set(ctx, stripeCache);
  }
  let t = stripeCache.get(key);
  if (!t) {
    const { canvas, ctx: c } = makeCanvas(128, 32);
    for (let i = 0; i < 8; i++) {
      c.fillStyle = i % 2 ? c2 : c1;
      c.fillRect(i * 16, 0, 16, 32);
    }
    const g = c.createLinearGradient(0, 0, 0, 32);
    g.addColorStop(0, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(0,0,0,0.12)');
    c.fillStyle = g;
    c.fillRect(0, 0, 128, 32);
    t = toTexture(canvas, { aniso: 4 });
    ctx.disposer.track(t);
    stripeCache.set(key, t);
  }
  return t;
}

export function buildBuildings(ctx: WorldCtx): BuildingsResult {
  const root = new THREE.Group();
  root.name = 'buildings';
  const { disposer } = ctx;
  const glowMats: THREE.MeshStandardMaterial[] = [];
  const neonMats: THREE.MeshBasicMaterial[] = [];
  const sconces: THREE.Vector3[] = [];
  const clockHands: { hour: THREE.Object3D; minute: THREE.Object3D }[] = [];
  const stringBulbs: THREE.Vector3[] = [];

  const awningMat = (c1: string, c2: string, w: number) => {
    const tex = stripeTexture(ctx, c1, c2).clone();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(Math.max(1, Math.round(w / 0.55) / 8), 1);
    tex.needsUpdate = true;
    disposer.track(tex);
    return disposer.track(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, side: THREE.DoubleSide }));
  };

  const addAwning = (g: THREE.Group, x: number, yTop: number, z: number, w: number, depth: number, drop: number, c1: string, c2: string) => {
    const mat = awningMat(c1, c2, w);
    const len = Math.hypot(depth, drop);
    const ang = Math.atan2(drop, depth);
    const top = new THREE.Mesh(disposer.track(new THREE.BoxGeometry(w, 0.05, len)), mat);
    top.position.set(x, yTop - drop / 2, z + depth / 2);
    top.rotation.x = ang;
    setShadow(top, true, true);
    const val = new THREE.Mesh(disposer.track(new THREE.BoxGeometry(w, 0.28, 0.05)), mat);
    val.position.set(x, yTop - drop - 0.12, z + depth);
    setShadow(val, true, true);
    g.add(top, val);
    // side triangles
    const side = new GeoBuilder();
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, depth, 0, -drop, depth], 3));
    tri.setAttribute('normal', new THREE.Float32BufferAttribute([1, 0, 0, 1, 0, 0, 1, 0, 0], 3));
    tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1], 2));
    for (const sx of [-1, 1]) side.add(tri.clone(), c1, x + (sx * w) / 2, yTop, z, { sx: 1 });
    const sm = new THREE.Mesh(disposer.track(side.build()), disposer.track(vcMaterial({ side: THREE.DoubleSide, roughness: 0.9 })));
    g.add(sm);
    // support rods
    const rods = new GeoBuilder();
    for (const sx of [-1, 1]) rods.box(0.03, 0.03, len, x + sx * (w / 2 - 0.1), yTop - drop / 2 - 0.08, z + depth / 2, '#33363c', { rx: ang });
    g.add(new THREE.Mesh(disposer.track(rods.build()), disposer.track(vcMaterial())));
    return { y: yTop - drop - 0.2 };
  };

  for (const b of BUILDINGS) {
    const st = STYLES[b.kind];
    const g = new THREE.Group();
    g.name = `building-${b.id}`;
    g.position.set(b.x, 0, b.z);
    g.rotation.y = b.door === 'S' ? 0 : Math.PI;
    const det = new GeoBuilder();
    const seed = hashString(b.id);
    const rng = mulberry32(seed);
    const doorX = b.kind === 'shop' ? 5.5 : 0;
    const hw = b.w / 2;
    const hd = b.d / 2;
    const L = wallLayout(b.kind, b.w, b.h);

    // ---------------------------------------------------------- walls
    const front = paintWall({ kind: b.kind, color: b.color, widthM: b.w, heightM: b.h, ppm: 40, face: 'front', doorX, seed });
    const side = paintWall({ kind: b.kind, color: b.color, widthM: b.d, heightM: b.h, ppm: 26, face: 'side', doorX: 0, seed: seed + 1 });
    const back = paintWall({ kind: b.kind, color: b.color, widthM: b.w, heightM: b.h, ppm: 18, face: 'back', doorX: 0, seed: seed + 2 });
    const mkMat = (p: { map: HTMLCanvasElement; emissive: HTMLCanvasElement }) => {
      const m = new THREE.MeshStandardMaterial({
        map: disposer.track(wallTexture(p.map)),
        emissiveMap: disposer.track(emissiveTexture(p.emissive)),
        emissive: new THREE.Color(1, 1, 1),
        emissiveIntensity: 0,
        roughness: 0.88,
        metalness: 0,
      });
      glowMats.push(m);
      return disposer.track(m);
    };
    const flatRoof = ['apartments', 'shop', 'arcade', 'post'].includes(b.kind);
    const topTex = ctx.rep(ctx.tex.roofFlat, b.w / 3, b.d / 3);
    const topMat = disposer.track(new THREE.MeshStandardMaterial({ map: topTex, color: flatRoof ? '#9a9aa0' : b.roof, roughness: 0.95 }));
    const body = new THREE.Mesh(disposer.track(wallGeometry(b.w, b.h, b.d)), [mkMat(front), mkMat(side), mkMat(back), topMat]);
    setShadow(body, true, true);
    g.add(body);

    // --------------------------------------------------------- roofs
    const trim = st.trim;
    const roofTile = ctx.rep(ctx.tex.roofTile, 1, 1);
    const roofMat = disposer.track(new THREE.MeshStandardMaterial({ map: roofTile, color: b.roof, roughness: 0.78, side: THREE.DoubleSide }));
    const addRoof = (type: 'gable' | 'hip', rise: number, over: number) => {
      const rm = new THREE.Mesh(disposer.track(roofGeometry(type, b.w, b.d, b.h, rise, over)), roofMat);
      setShadow(rm, true, true);
      g.add(rm);
      // eave fascia
      const k = rise / hd;
      const ey = b.h - k * over;
      det.boxB(b.w + over * 2, 0.16, 0.1, 0, ey - 0.08, hd + over, shade(trim, 0.9) as string);
      det.boxB(b.w + over * 2, 0.16, 0.1, 0, ey - 0.08, -hd - over, shade(trim, 0.9) as string);
      if (type === 'hip') {
        det.boxB(0.1, 0.16, b.d + over * 2, -hw - over, ey - 0.08, 0, shade(trim, 0.9) as string);
        det.boxB(0.1, 0.16, b.d + over * 2, hw + over, ey - 0.08, 0, shade(trim, 0.9) as string);
      }
      // soffit
      det.boxB(b.w + over * 2, 0.06, b.d + over * 2, 0, ey - 0.2, 0, '#4a3a2c');
    };
    if (b.kind === 'bakery') {
      addRoof('gable', 2.3, 0.7);
      // gable end triangles
      const tri = new THREE.BufferGeometry();
      tri.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -hd, 0, 0, hd, 0, 2.3, 0], 3));
      tri.setAttribute('normal', new THREE.Float32BufferAttribute([1, 0, 0, 1, 0, 0, 1, 0, 0], 3));
      tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
      for (const sx of [-1, 1]) det.add(tri.clone(), b.color, sx * (hw + 0.01), b.h, 0, { ry: sx > 0 ? 0 : Math.PI });
      // chimney
      det.boxB(0.9, 2.6, 0.9, hw * 0.55, b.h + 0.4, -hd * 0.3, '#8a4b38');
      det.boxB(1.1, 0.14, 1.1, hw * 0.55, b.h + 2.96, -hd * 0.3, '#5a3a2e');
    } else if (b.kind === 'cafe') {
      addRoof('hip', 1.8, 0.6);
      det.boxB(0.7, 2.2, 0.7, -hw * 0.5, b.h + 0.3, -hd * 0.25, '#7a4a38');
      det.boxB(0.9, 0.12, 0.9, -hw * 0.5, b.h + 2.5, -hd * 0.25, '#4e3a30');
    } else if (b.kind === 'library') {
      addRoof('hip', 2.4, 0.6);
      // cupola
      det.boxB(2.0, 1.1, 2.0, 0, b.h + 2.0, 0, '#e6dccb');
      det.boxB(2.4, 0.14, 2.4, 0, b.h + 3.1, 0, '#d4c8b2');
      det.add(new THREE.ConeGeometry(1.4, 1.2, 4), b.roof, 0, b.h + 3.8, 0, { ry: Math.PI / 4 });
      det.cylB(0.03, 0.03, 0.8, 5, 0, b.h + 4.4, 0, '#c8a24a');
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) det.boxB(0.14, 0.9, 0.14, sx * 0.8, b.h + 2.1, sz * 0.8, '#cbbfa8');
    } else if (b.kind === 'hall') {
      addRoof('hip', 2.2, 0.55);
    } else {
      // flat roof: parapet
      const ph = 0.7;
      det.boxB(b.w + 0.3, ph, 0.28, 0, b.h, hd, trim);
      det.boxB(b.w + 0.3, ph, 0.28, 0, b.h, -hd, trim);
      det.boxB(0.28, ph, b.d + 0.3, -hw, b.h, 0, trim);
      det.boxB(0.28, ph, b.d + 0.3, hw, b.h, 0, trim);
      det.boxB(b.w + 0.45, 0.07, 0.4, 0, b.h + ph, hd, shade(trim, 0.85) as string);
      det.boxB(b.w + 0.45, 0.07, 0.4, 0, b.h + ph, -hd, shade(trim, 0.85) as string);
      det.boxB(0.4, 0.07, b.d + 0.45, -hw, b.h + ph, 0, shade(trim, 0.85) as string);
      det.boxB(0.4, 0.07, b.d + 0.45, hw, b.h + ph, 0, shade(trim, 0.85) as string);
      // rooftop equipment
      const n = Math.max(2, Math.round(b.w / 5));
      for (let i = 0; i < n; i++) {
        const x = -hw + 1.8 + rng() * (b.w - 3.6);
        const z = -hd + 1.6 + rng() * (b.d * 0.5);
        const r = rng();
        if (r < 0.45) {
          det.boxB(1.4, 0.8, 1.0, x, b.h, z, '#b8bcc2');
          det.cylB(0.35, 0.35, 0.1, 10, x - 0.3, b.h + 0.8, z, '#33363c');
          det.cylB(0.35, 0.35, 0.1, 10, x + 0.35, b.h + 0.8, z, '#33363c');
        } else if (r < 0.75) {
          det.boxB(1.0, 1.2, 1.0, x, b.h, z, '#8c9099');
          det.cylB(0.3, 0.3, 0.5, 8, x, b.h + 1.2, z, '#6d7179');
        } else {
          det.boxB(1.8, 1.6, 1.6, x, b.h, z, shade(b.color, 0.85) as string);
          det.boxB(1.9, 0.1, 1.7, x, b.h + 1.6, z, '#5a5a60');
        }
      }
      if (b.kind === 'apartments') {
        // water tank on legs + antenna
        const tx = -hw + 2.2;
        const tz = -hd + 2.2;
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) det.boxB(0.12, 1.5, 0.12, tx + sx * 0.7, b.h, tz + sz * 0.7, '#4b4f57');
        det.cylB(1.0, 1.0, 1.7, 14, tx, b.h + 1.5, tz, '#8a5a3a');
        det.cylB(0.0, 1.05, 0.5, 14, tx, b.h + 3.2, tz, '#5a3a28');
        det.cylB(0.03, 0.03, 3.4, 5, hw - 1.4, b.h, -hd + 1.2, '#4b4f57');
        det.box(0.9, 0.03, 0.03, hw - 1.4, b.h + 2.8, -hd + 1.2, '#4b4f57');
        det.box(0.6, 0.03, 0.03, hw - 1.4, b.h + 3.2, -hd + 1.2, '#4b4f57');
      }
    }

    // ------------------------------------------------------- entrance
    const doorZ = hd;
    const dW = st.doorW;
    const dH = st.doorH;
    const glassDoor = ['shop', 'cafe', 'bakery', 'arcade', 'post', 'apartments'].includes(b.kind);
    const woodDoor = b.kind === 'hall' || b.kind === 'library';
    const frameCol = b.kind === 'arcade' ? '#17122e' : shade(trim, 0.82);
    det.boxB(dW + 0.34, dH + 0.22, 0.1, doorX, 0, doorZ + 0.03, frameCol as string);
    det.boxB(dW, dH, 0.08, doorX, 0, doorZ + 0.09, glassDoor ? '#1e2f3d' : woodDoor ? '#4b2e1c' : '#6b4429');
    if (glassDoor) {
      det.boxB(0.07, dH * 0.92, 0.1, doorX, 0.05, doorZ + 0.11, '#c9ccd2');
      for (const sx of [-1, 1]) det.boxB(0.05, 0.9, 0.06, doorX + sx * 0.18, 1.0, doorZ + 0.17, '#d6d8dc');
      det.boxB(dW, 0.5, 0.1, doorX, 0.0, doorZ + 0.12, shade(frameCol as string, 0.8) as string);
    } else {
      for (const sx of [-1, 1]) {
        det.boxB(dW / 2 - 0.2, dH - 0.5, 0.06, doorX + sx * dW / 4, 0.25, doorZ + 0.14, '#5b3a24');
        det.sphere(0.05, 6, 5, doorX + sx * 0.14, 1.1, doorZ + 0.2, '#d6b25a');
      }
    }
    // threshold + mat
    det.boxB(dW + 0.5, 0.05, 0.7, doorX, SIDEWALK_H, doorZ + 0.35, '#8d8a82');
    det.boxB(dW * 0.8, 0.025, 0.5, doorX, SIDEWALK_H + 0.05, doorZ + 0.4, '#5a3a2a');
    // sconces beside the door
    for (const sx of [-1, 1]) {
      const sx0 = doorX + sx * (dW / 2 + 0.55);
      det.boxB(0.12, 0.28, 0.1, sx0, 2.2, doorZ + 0.07, '#2b2f36');
      sconces.push(new THREE.Vector3(sx0, 2.5, doorZ + 0.16));
      g.userData.dummy = 1;
    }

    // ------------------------------------------------------ the sign
    const signSpec: Record<Building['kind'], { w: number; y: number; x: number }> = {
      bakery: { w: Math.min(6.2, b.w - 2), y: L.gfH - 0.62, x: 0 },
      shop: { w: Math.min(7.4, b.w - 2), y: L.gfH - 0.6, x: 0 },
      cafe: { w: Math.min(6.2, b.w - 2), y: L.gfH - 0.62, x: 0 },
      post: { w: Math.min(5.6, b.w - 1.4), y: L.gfH - 0.6, x: 0 },
      arcade: { w: Math.min(7.2, b.w - 2), y: L.gfH - 0.6, x: 0 },
      library: { w: 3.9, y: L.gfH - 0.55, x: 0 },
      hall: { w: 4.4, y: L.gfH - 0.55, x: 0 },
      apartments: { w: Math.min(4.4, b.w - 1.4), y: L.gfH - 0.5, x: 0 },
    };
    const ss = signSpec[b.kind];
    const sign = paintSign(b.name, b.kind);
    const signTex = disposer.track(wallTexture(sign.map));
    const signEm = disposer.track(emissiveTexture(sign.emissive));
    const sh = ss.w * (192 / 1024);
    const signMat = disposer.track(
      new THREE.MeshStandardMaterial({ map: signTex, emissiveMap: signEm, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0.1, roughness: 0.6, metalness: 0 }),
    );
    const signMesh = new THREE.Mesh(disposer.track(new THREE.PlaneGeometry(ss.w, sh)), signMat);
    signMesh.position.set(ss.x, ss.y, hd + 0.2);
    g.add(signMesh);
    det.boxB(ss.w + 0.16, sh + 0.16, 0.12, ss.x, ss.y - sh / 2 - 0.08, hd + 0.1, SIGN_STYLES[b.kind].neon ? '#0d0a1c' : '#2b2f36');
    for (const sx of [-1, 1]) det.boxB(0.06, 0.3, 0.14, ss.x + sx * (ss.w / 2 - 0.3), ss.y + sh / 2 + 0.06, hd + 0.12, '#2b2f36');
    const signGlow = SIGN_STYLES[b.kind].neon ? 0.85 : 0.55;
    ctx.updaters.push((_dt, _t, env) => {
      signMat.emissiveIntensity = (SIGN_STYLES[b.kind].neon ? 0.55 : 0.08) + env.windowGlow * signGlow * (SIGN_STYLES[b.kind].neon ? 1 : 1);
    });

    // ----------------------------------------------- kind specific bits
    if (b.kind === 'bakery') {
      addAwning(g, -3.6, 3.2, hd + 0.05, 3.6, 1.4, 0.45, '#c9453a', '#fbf1dc');
      addAwning(g, 3.6, 3.2, hd + 0.05, 3.6, 1.4, 0.45, '#c9453a', '#fbf1dc');
      // sandwich board + bread crates outside
      det.boxB(0.7, 1.0, 0.06, -2.4, SIDEWALK_H, hd + 1.2, '#2e3b34', { rx: -0.12 });
      det.boxB(0.78, 0.04, 0.5, -2.4, SIDEWALK_H + 0.5, hd + 1.0, '#7a5a3a');
      for (let i = 0; i < 4; i++) det.sphere(0.12, 6, 4, -2.7 + i * 0.2, SIDEWALK_H + 0.58, hd + 1.0, '#c98a4a', { sy: 0.7, sx: 1.3 });
      det.boxB(0.8, 0.45, 0.5, 2.6, SIDEWALK_H, hd + 0.8, '#9a6a3c');
      for (let i = 0; i < 5; i++) det.sphere(0.13, 6, 4, 2.3 + i * 0.16, SIDEWALK_H + 0.5, hd + 0.8, '#e0b070', { sy: 0.8, sx: 1.3 });
    } else if (b.kind === 'cafe') {
      addAwning(g, -3.4, 3.1, hd + 0.05, 3.8, 1.5, 0.45, '#3e7a56', '#f6ecd8');
      addAwning(g, 3.4, 3.1, hd + 0.05, 3.8, 1.5, 0.45, '#3e7a56', '#f6ecd8');
      // outdoor tables with parasols (inside the sidewalk zone, close to the wall)
      for (const tx of [-5.0, 5.0]) {
        const tz = hd + 1.35;
        det.cylB(0.45, 0.45, 0.05, 14, tx, SIDEWALK_H + 0.72, tz, '#f2e6cf');
        det.cylB(0.04, 0.04, 0.72, 6, tx, SIDEWALK_H, tz, '#2b2f36');
        det.cylB(0.22, 0.22, 0.03, 10, tx, SIDEWALK_H, tz, '#2b2f36');
        for (const a of [0.6, 2.7, 4.2]) {
          const cx = tx + Math.cos(a) * 0.72;
          const cz = tz + Math.sin(a) * 0.72;
          det.boxB(0.38, 0.05, 0.38, cx, SIDEWALK_H + 0.44, cz, '#3e7a56');
          det.boxB(0.38, 0.4, 0.04, cx + Math.cos(a) * 0.17, SIDEWALK_H + 0.46, cz + Math.sin(a) * 0.17, '#3e7a56', { ry: -a });
          for (const sx of [-1, 1]) for (const sz of [-1, 1]) det.boxB(0.035, 0.44, 0.035, cx + sx * 0.15, SIDEWALK_H, cz + sz * 0.15, '#2b2f36');
        }
        det.cylB(0.35, 0.35, 0.035, 10, tx + 0.15, SIDEWALK_H + 0.77, tz - 0.1, '#e8e2d4');
        det.cylB(0.04, 0.04, 0.12, 8, tx - 0.2, SIDEWALK_H + 0.77, tz + 0.1, '#e8e2d4');
      }
      // chalkboard menu
      det.boxB(0.75, 1.05, 0.06, 2.5, SIDEWALK_H, hd + 0.55, '#2b2b2b', { rx: -0.14 });
      det.boxB(0.62, 0.9, 0.02, 2.5, SIDEWALK_H + 0.07, hd + 0.59, '#1c2b24', { rx: -0.14 });
      for (let i = 0; i < 5; i++) det.boxB(0.4 - (i % 2) * 0.1, 0.02, 0.01, 2.5, SIDEWALK_H + 0.3 + i * 0.13, hd + 0.56 + i * 0.015, '#f4f0e0');
    } else if (b.kind === 'shop') {
      // main entrance awning (small, over the real door at the right)
      addAwning(g, doorX, 3.25, hd + 0.05, 2.9, 1.2, 0.4, '#f2b632', '#fff');
    } else if (b.kind === 'arcade') {
      // neon strip + roof marquee
      const neonA = new THREE.MeshBasicMaterial({ color: '#ff3fd0', toneMapped: false });
      const neonB = new THREE.MeshBasicMaterial({ color: '#35e8ff', toneMapped: false });
      neonMats.push(neonA, neonB);
      const strip = (m: THREE.Material, x: number, y: number, w2: number, h2: number) => {
        const s = new THREE.Mesh(disposer.track(new THREE.BoxGeometry(w2, h2, 0.07)), m);
        s.position.set(x, y, hd + 0.08);
        g.add(s);
      };
      strip(neonA, 0, b.h - 0.55, b.w - 1.0, 0.1);
      strip(neonB, 0, b.h - 0.8, b.w - 1.0, 0.07);
      strip(neonA, -hw + 0.5, b.h / 2 + 1.5, 0.1, b.h - 3.2);
      strip(neonB, hw - 0.5, b.h / 2 + 1.5, 0.1, b.h - 3.2);
      // arrow-shaped marquee on the roof: text board facing the street
      const mq = paintSign('ARCADE', 'arcade');
      const mqTex = disposer.track(wallTexture(mq.map));
      const mqEm = disposer.track(emissiveTexture(mq.emissive));
      const mqMat = disposer.track(new THREE.MeshStandardMaterial({ map: mqTex, emissiveMap: mqEm, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0.6, roughness: 0.6 }));
      const mqMesh = new THREE.Mesh(disposer.track(new THREE.PlaneGeometry(6.4, 1.2)), mqMat);
      mqMesh.position.set(0, b.h + 1.9, hd - 0.9);
      g.add(mqMesh);
      det.boxB(6.5, 1.3, 0.2, 0, b.h + 1.25, hd - 1.05, '#0d0a1c');
      for (const sx of [-1, 1]) det.boxB(0.12, 1.3, 0.12, sx * 2.8, b.h + 0.7, hd - 0.9, '#2b2f36');
      ctx.updaters.push((_dt, _t, env) => {
        mqMat.emissiveIntensity = 0.5 + env.windowGlow * 0.9;
        const k = 0.45 + env.windowGlow * 1.6;
        neonA.color.setRGB(1 * k, 0.25 * k, 0.8 * k);
        neonB.color.setRGB(0.2 * k, 0.9 * k, 1 * k);
      });
    } else if (b.kind === 'post') {
      // flagpole + mail slot
      det.cylB(0.05, 0.06, 4.6, 8, hw - 1.0, b.h, hd - 0.7, '#cfd2d8');
      det.box(1.1, 0.7, 0.03, hw - 0.4, b.h + 4.0, hd - 0.7, '#c93a3a');
      det.box(0.5, 0.35, 0.03, hw - 0.7, b.h + 4.18, hd - 0.69, '#2f5db0');
      addAwning(g, 0, 3.15, hd + 0.05, 2.6, 1.0, 0.35, '#c93a3a', '#fff');
    } else if (b.kind === 'library') {
      // portal: pilasters, lintel, pediment, steps (flush so the sidewalk stays clear)
      for (const sx of [-1, 1]) {
        det.cylB(0.26, 0.3, 3.4, 12, sx * 1.75, 0.15, hd + 0.3, '#e9dfcd');
        det.boxB(0.7, 0.18, 0.7, sx * 1.75, 0.0, hd + 0.3, '#cdbfa6');
        det.boxB(0.7, 0.2, 0.7, sx * 1.75, 3.55, hd + 0.3, '#d9cdb5');
      }
      det.boxB(4.4, 0.4, 0.8, 0, 3.75, hd + 0.3, '#e9dfcd');
      const ped = new THREE.BufferGeometry();
      ped.setAttribute('position', new THREE.Float32BufferAttribute([-2.4, 0, 0, 2.4, 0, 0, 0, 1.1, 0], 3));
      ped.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
      ped.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
      det.add(ped, '#e9dfcd', 0, 4.15, hd + 0.62);
      det.box(0, 0, 0, 0, 0, 0, '#000');
    } else if (b.kind === 'hall') {
      // engaged columns + pediment + steps
      for (const cx of [-5.4, -1.8, 1.8, 5.4]) {
        det.cylB(0.34, 0.38, 7.1, 14, cx, 0.2, hd + 0.35, '#efe8d8');
        det.boxB(0.9, 0.22, 0.9, cx, 0.0, hd + 0.35, '#d4c9b2');
        det.boxB(0.9, 0.24, 0.9, cx, 7.3, hd + 0.35, '#d9cfba');
      }
      det.boxB(13.2, 0.55, 1.2, 0, 7.55, hd + 0.35, '#efe8d8');
      const ped = new THREE.BufferGeometry();
      ped.setAttribute('position', new THREE.Float32BufferAttribute([-6.9, 0, 0, 6.9, 0, 0, 0, 2.1, 0], 3));
      ped.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
      ped.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
      det.add(ped, '#efe8d8', 0, 8.1, hd + 0.95);
      det.add(ped.clone(), '#cdbfa6', 0, 8.35, hd + 0.96, { sx: 0.8, sy: 0.7 });
      det.boxB(14, 0.2, 1.6, 0, SIDEWALK_H, hd + 0.5, '#bdb39d');
      det.boxB(7.4, 0.2, 2.0, 0, SIDEWALK_H, hd + 0.9, '#b3a98f');
      // clock tower
      const TW = 4.6;
      const tBase = b.h - 0.5;
      const tBody = tBase + 8.6;
      det.boxB(TW, 8.6, TW, 0, tBase, 0, '#d9d1bc');
      det.boxB(TW + 0.4, 0.3, TW + 0.4, 0, tBody, 0, '#c8bda4');
      det.boxB(TW - 0.7, 2.6, TW - 0.7, 0, tBody + 0.3, 0, '#d4ccb7');
      for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
        // belfry arches
        det.boxB(az ? 1.0 : 0.06, 1.7, az ? 0.06 : 1.0, ax * (TW - 0.7) / 2 + ax * 0.02, tBody + 0.7, az * (TW - 0.7) / 2 + az * 0.02, '#2b2620');
      }
      det.boxB(TW + 0.2, 0.25, TW + 0.2, 0, tBody + 2.9, 0, '#c8bda4');
      det.add(new THREE.ConeGeometry(TW * 0.74, 3.6, 4), '#4f8f7c', 0, tBody + 3.15 + 1.8, 0, { ry: Math.PI / 4 });
      det.cylB(0.04, 0.04, 1.4, 6, 0, tBody + 6.7, 0, '#c8a24a');
      det.sphere(0.14, 8, 6, 0, tBody + 6.9, 0, '#c8a24a');
      // clock faces
      const faceTex = disposer.track(toTexture(paintClockFace(), { repeat: false }));
      const faceMat = disposer.track(new THREE.MeshStandardMaterial({ map: faceTex, emissiveMap: faceTex, emissive: new THREE.Color(1, 0.95, 0.8), emissiveIntensity: 0, roughness: 0.6 }));
      glowMats.push(faceMat);
      const handMat = disposer.track(new THREE.MeshStandardMaterial({ color: '#1d1a16', roughness: 0.5 }));
      const fy = tBase + 6.2;
      for (const [nx, nz] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as [number, number][]) {
        const piv = new THREE.Group();
        piv.position.set(nx * (TW / 2 + 0.06), fy, nz * (TW / 2 + 0.06));
        piv.rotation.y = Math.atan2(nx, nz);
        const face = new THREE.Mesh(disposer.track(new THREE.CircleGeometry(1.5, 32)), faceMat);
        piv.add(face);
        const hourP = new THREE.Group();
        const hourH = new THREE.Mesh(disposer.track(new THREE.BoxGeometry(0.14, 0.85, 0.05)), handMat);
        hourH.position.y = 0.38;
        hourP.add(hourH);
        hourP.position.z = 0.04;
        const minP = new THREE.Group();
        const minH = new THREE.Mesh(disposer.track(new THREE.BoxGeometry(0.09, 1.25, 0.05)), handMat);
        minH.position.y = 0.55;
        minP.add(minH);
        minP.position.z = 0.07;
        piv.add(hourP, minP);
        g.add(piv);
        clockHands.push({ hour: hourP, minute: minP });
      }
    } else if (b.kind === 'apartments') {
      addAwning(g, 0, 3.0, hd + 0.05, 2.8, 1.0, 0.3, '#5a6572', '#8a95a1');
    }

    // ----------------------------------------------------- detail mesh
    const dm = new THREE.Mesh(disposer.track(det.build()), disposer.track(vcMaterial({ roughness: 0.78, side: THREE.DoubleSide })));
    setShadow(dm, true, true);
    g.add(dm);
    root.add(g);
  }

  // ------------------------------------------------------------ kiosk
  buildKiosk(ctx, root, stringBulbs);

  // wall sconces (instanced bulbs + halos)
  const world = (v: THREE.Vector3, b: Building): THREE.Vector3 => {
    const s = b.door === 'S' ? 1 : -1;
    return new THREE.Vector3(b.x + v.x * s, v.y, b.z + v.z * s);
  };
  const allSconces: THREE.Vector3[] = [];
  {
    let i = 0;
    for (const b of BUILDINGS) {
      for (let k = 0; k < 2; k++) allSconces.push(world(sconces[i++], b));
    }
  }
  const bulbGeo = disposer.track(new THREE.SphereGeometry(0.1, 8, 6));
  const bulbMat = disposer.track(new THREE.MeshBasicMaterial({ color: '#d9d4c0', toneMapped: false }));
  const bulbs = new THREE.InstancedMesh(bulbGeo, bulbMat, allSconces.length + stringBulbs.length);
  const o = new THREE.Object3D();
  [...allSconces, ...stringBulbs].forEach((p, i) => {
    o.position.copy(p);
    o.updateMatrix();
    bulbs.setMatrixAt(i, o.matrix);
  });
  bulbs.frustumCulled = false;
  root.add(bulbs);
  const all = [...allSconces, ...stringBulbs];
  const halo = createParticles({
    count: all.length,
    map: ctx.tex.softCircle,
    color: '#ffc27a',
    additive: true,
    seedFn: (i, s) => { s[0] = all[i].x; s[1] = all[i].y; s[2] = all[i].z; },
    motion: 'center = seed.xyz; size = 1.1; alpha = uLight * 0.7;',
  });
  root.add(halo.mesh);

  ctx.updaters.push((_dt, time, env) => {
    const wg = env.windowGlow;
    for (const m of glowMats) m.emissiveIntensity = wg * 1.15;
    const k = 0.5 + env.lampOn * 1.3;
    bulbMat.color.setRGB(0.8 + env.lampOn * 0.2, 0.75 + env.lampOn * 0.1, 0.6 - env.lampOn * 0.2).multiplyScalar(k);
    halo.update(time, env.lampOn);
    halo.mesh.visible = env.lampOn > 0.01;
  });
  void neonMats;
  return {
    root,
    setClock(t: number) {
      const hours = (t * 24) % 12;
      const hourAng = -(hours / 12) * Math.PI * 2;
      const minAng = -((hours % 1)) * Math.PI * 2;
      for (const c of clockHands) {
        c.hour.rotation.z = hourAng;
        c.minute.rotation.z = minAng;
      }
    },
  };
}

// ------------------------------------------------------------------ kiosk
function buildKiosk(ctx: WorldCtx, root: THREE.Group, stringBulbs: THREE.Vector3[]): void {
  const { disposer } = ctx;
  const g = new THREE.Group();
  g.name = 'kiosk';
  g.position.set(SHOP_COUNTER.x, 0, 0);
  const cz = SHOP_COUNTER.z; // counter centre z (-9.8)
  const wallZ = -12; // market front wall
  const hw = SHOP_COUNTER.w / 2;
  const k = new GeoBuilder();
  const WOOD = '#a9764a';
  const WOODD = '#865a36';
  const TOP = '#efe6d2';
  const y0 = SIDEWALK_H;
  // counter cabinet with panelled front
  k.boxB(SHOP_COUNTER.w, 1.0, SHOP_COUNTER.d, 0, y0, cz, WOOD);
  for (let i = 0; i < 5; i++) k.boxB(0.82, 0.7, 0.04, -hw + 0.6 + i * 1.0, y0 + 0.15, cz + SHOP_COUNTER.d / 2 + 0.01, WOODD);
  k.boxB(SHOP_COUNTER.w + 0.3, 0.08, SHOP_COUNTER.d + 0.4, 0, y0 + 1.0, cz, TOP);
  // side walls (wood planks) and back wall shelves
  for (const sx of [-1, 1]) {
    k.boxB(0.2, 2.7, 2.6, sx * (hw + 0.1), y0, -10.8, WOODD);
    k.boxB(0.26, 0.12, 2.7, sx * (hw + 0.1), y0 + 2.7, -10.8, '#6e4a2c');
  }
  // back shelving along the market wall
  for (let r = 0; r < 4; r++) k.boxB(SHOP_COUNTER.w - 0.2, 0.06, 0.45, 0, y0 + 0.5 + r * 0.55, wallZ + 0.3, WOODD);
  for (const sx of [-1, 1]) k.boxB(0.06, 2.3, 0.45, sx * (hw - 0.15), y0, wallZ + 0.3, WOODD);
  const rng = mulberry32(4242);
  const goodsCols = ['#d9553f', '#f2b134', '#4fa35b', '#5a8fd0', '#e8e4dc', '#b97bd6', '#ff8a3d'];
  for (let r = 0; r < 4; r++) {
    for (let x = -hw + 0.35; x < hw - 0.3; x += 0.28 + rng() * 0.2) {
      const c = goodsCols[Math.floor(rng() * goodsCols.length)];
      const hh = 0.18 + rng() * 0.2;
      if (rng() > 0.45) k.boxB(0.18 + rng() * 0.1, hh, 0.2, x, y0 + 0.56 + r * 0.55, wallZ + 0.3, c);
      else k.cylB(0.08, 0.08, hh + 0.05, 8, x, y0 + 0.56 + r * 0.55, wallZ + 0.3, c);
    }
  }
  // goods on the counter: cash register, crates with fruit, scale, jars
  k.boxB(0.5, 0.2, 0.4, -1.7, y0 + 1.08, cz - 0.05, '#3a3d44');
  k.boxB(0.34, 0.2, 0.05, -1.7, y0 + 1.3, cz - 0.17, '#1c2b36', { rx: -0.3 });
  k.boxB(0.9, 0.28, 0.6, 1.3, y0 + 1.08, cz + 0.02, '#8a5c32');
  for (let i = 0; i < 8; i++) k.sphere(0.1, 7, 5, 1.0 + (i % 4) * 0.2, y0 + 1.4, cz - 0.1 + Math.floor(i / 4) * 0.22, i % 2 ? '#d9483b' : '#7fb83f');
  k.boxB(0.9, 0.28, 0.6, 0.0, y0 + 1.08, cz + 0.02, '#8a5c32');
  for (let i = 0; i < 8; i++) k.sphere(0.095, 7, 5, -0.3 + (i % 4) * 0.2, y0 + 1.4, cz - 0.1 + Math.floor(i / 4) * 0.22, i % 2 ? '#f0a02e' : '#f2d23a');
  for (let i = 0; i < 3; i++) {
    k.cylB(0.09, 0.09, 0.26, 8, -0.9 + i * 0.22, y0 + 1.08, cz + 0.12, '#cfe3ea');
    k.cylB(0.095, 0.095, 0.05, 8, -0.9 + i * 0.22, y0 + 1.34, cz + 0.12, '#c8a24a');
  }
  // floor stock: crates and sacks on the sides inside the stall
  for (const sx of [-1, 1]) {
    k.boxB(0.6, 0.4, 0.5, sx * (hw - 0.45), y0, -11.5, '#8a5c32');
    k.boxB(0.55, 0.35, 0.45, sx * (hw - 0.5), y0 + 0.4, -11.5, '#9a6a3c');
    k.cylB(0.28, 0.32, 0.6, 8, sx * (hw - 0.4), y0, -10.6, '#c9b48a');
  }
  // hanging price board
  k.boxB(1.5, 0.5, 0.06, 0, y0 + 2.0, cz + SHOP_COUNTER.d / 2 + 0.25, '#2b2f36');
  for (const sx of [-1, 1]) k.boxB(0.03, 0.4, 0.03, sx * 0.6, y0 + 2.5, cz + SHOP_COUNTER.d / 2 + 0.25, '#2b2f36');
  const km = new THREE.Mesh(disposer.track(k.build()), disposer.track(vcMaterial({ roughness: 0.8, side: THREE.DoubleSide })));
  setShadow(km, true, true);
  g.add(km);

  // striped canopy over the stall
  const w = SHOP_COUNTER.w + 0.7;
  const depth = cz + 1.0 - wallZ; // from wall to just in front of the counter
  const tex = stripeTexture(ctx, '#e8453c', '#fff6e8').clone();
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(w / 0.55 / 8, 1);
  tex.needsUpdate = true;
  disposer.track(tex);
  const cm = disposer.track(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, side: THREE.DoubleSide }));
  const yTop = y0 + 3.15;
  const drop = 0.55;
  const len = Math.hypot(depth, drop);
  const top = new THREE.Mesh(disposer.track(new THREE.BoxGeometry(w, 0.05, len)), cm);
  top.position.set(0, yTop - drop / 2, wallZ + depth / 2);
  top.rotation.x = Math.atan2(drop, depth);
  setShadow(top, true, true);
  const val = new THREE.Mesh(disposer.track(new THREE.BoxGeometry(w, 0.3, 0.05)), cm);
  val.position.set(0, yTop - drop - 0.13, wallZ + depth);
  setShadow(val, true, true);
  g.add(top, val);
  // posts at the front corners + string lights
  const p = new GeoBuilder();
  for (const sx of [-1, 1]) p.boxB(0.12, yTop - drop - y0 + 0.05, 0.12, sx * (hw + 0.28), y0, cz + 0.85, '#6e4a2c');
  const pm = new THREE.Mesh(disposer.track(p.build()), disposer.track(vcMaterial()));
  setShadow(pm, true, true);
  g.add(pm);
  for (let i = 0; i < 9; i++) {
    const x = -hw - 0.2 + (i / 8) * (SHOP_COUNTER.w + 0.4);
    stringBulbs.push(new THREE.Vector3(SHOP_COUNTER.x + x, yTop - drop - 0.38 + Math.sin(i * 0.8) * 0.04, wallZ + depth - 0.1));
  }
  // "OPEN" board on the counter edge
  const { canvas, ctx: c } = makeCanvas(256, 96);
  c.fillStyle = '#2b2f36';
  c.fillRect(0, 0, 256, 96);
  c.fillStyle = '#ffd45a';
  c.font = 'bold 56px Arial, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('SHOP', 128, 50);
  const sTex = disposer.track(toTexture(canvas, { repeat: false }));
  const sMat = disposer.track(new THREE.MeshStandardMaterial({ map: sTex, emissiveMap: sTex, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0.2 }));
  const sMesh = new THREE.Mesh(disposer.track(new THREE.PlaneGeometry(1.5, 0.56)), sMat);
  sMesh.position.set(0, y0 + 2.0, cz + SHOP_COUNTER.d / 2 + 0.29);
  g.add(sMesh);
  ctx.updaters.push((_dt, _t, env) => {
    sMat.emissiveIntensity = 0.25 + env.windowGlow * 0.8;
  });
  void SHOPKEEPER_POS;
  root.add(g);
}
