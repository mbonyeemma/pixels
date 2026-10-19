import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BUILDINGS, PERIMETER_TREES, PROPS } from '@pixels/shared';
import { GeoBuilder, jitterFaces, setShadow, vcMaterial, verticalShade } from '../gfx/geo';
import { mulberry32, hashString } from '../logic/palette';
import { outerHeight } from '../gfx/terrain';
import { isOpenGrass } from '../logic/layout';
import type { WorldCtx } from './ctx';

type Rng = () => number;

function blob(b: GeoBuilder, rng: Rng, r: number, x: number, y: number, z: number, color: string, detail: number, squash = 0.85): void {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  // radial wobble, deterministic per vertex position so shared vertices stay joined
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i);
    const vy = pos.getY(i);
    const vz = pos.getZ(i);
    const h = hashString(`${vx.toFixed(3)},${vy.toFixed(3)},${vz.toFixed(3)}`) / 4294967296;
    const k = 1 + (h - 0.5) * 0.3;
    pos.setXYZ(i, vx * k, vy * k * squash, vz * k);
  }
  b.add(g, color, x, y, z, { ry: rng() * 6.28 });
}

function finishTree(trunk: GeoBuilder, crown: GeoBuilder, rng: Rng, y0: number, y1: number): THREE.BufferGeometry {
  const t = trunk.build();
  const c = crown.build();
  c.computeVertexNormals();
  jitterFaces(c, rng, 0.11);
  verticalShade(c, y0, y1, 0.62, 1.18);
  const g = mergeGeometries([t, c], false);
  t.dispose();
  c.dispose();
  g.computeBoundingSphere();
  return g;
}

export type TreeKind = 'oak' | 'pine' | 'cypress';

export function treeGeometry(kind: TreeKind, level: 'near' | 'mid' | 'far'): THREE.BufferGeometry {
  const rng = mulberry32(kind === 'oak' ? 11 : kind === 'pine' ? 22 : 33);
  const detail = level === 'near' ? 1 : 0;
  const trunk = new GeoBuilder();
  const crown = new GeoBuilder();
  const seg = level === 'near' ? 7 : 5;
  if (kind === 'oak') {
    trunk.cylB(0.17, 0.3, 2.5, seg, 0, 0, 0, '#7a5a3e');
    if (level !== 'far') {
      trunk.cylB(0.07, 0.12, 1.2, 5, 0.35, 1.8, 0.1, '#7a5a3e', { rz: -0.7 });
      trunk.cylB(0.07, 0.12, 1.1, 5, -0.3, 2.0, -0.1, '#7a5a3e', { rz: 0.7 });
    }
    const blobs: [number, number, number, number, string][] = [
      [1.75, 0, 3.7, 0, '#3f7a34'],
      [1.3, 1.05, 3.2, 0.45, '#4a8a3a'],
      [1.35, -0.95, 3.1, -0.5, '#3a7030'],
      [1.2, 0.1, 4.7, 0.1, '#58a043'],
      [1.05, -0.5, 3.4, 1.0, '#4f9540'],
    ];
    const use = level === 'far' ? blobs.slice(0, 2) : level === 'mid' ? blobs.slice(0, 4) : blobs;
    for (const [r, x, y, z, c] of use) blob(crown, rng, r, x, y, z, c, detail);
    return finishTree(trunk, crown, rng, 2, 5.6);
  }
  if (kind === 'pine') {
    trunk.cylB(0.14, 0.26, 2.2, seg, 0, 0, 0, '#6e4f36');
    const cones: [number, number, number, string][] = [
      [1.95, 2.4, 1.2, '#2c5a3a'],
      [1.6, 2.3, 2.4, '#31653f'],
      [1.2, 2.1, 3.7, '#38724a'],
      [0.8, 1.8, 5.0, '#417f52'],
    ];
    const use = level === 'far' ? [cones[0], cones[2]] : cones;
    for (const [r, h, y, c] of use) {
      const g = new THREE.ConeGeometry(r, h, level === 'near' ? 9 : 6);
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const k = 1 + (hashString(`${pos.getX(i).toFixed(2)}${pos.getZ(i).toFixed(2)}`) / 4294967296 - 0.5) * 0.18;
        pos.setXYZ(i, pos.getX(i) * k, pos.getY(i), pos.getZ(i) * k);
      }
      crown.add(g, c, 0, y + h / 2, 0, { ry: rng() * 6 });
    }
    return finishTree(trunk, crown, rng, 1.2, 6.2);
  }
  // cypress: tall narrow
  trunk.cylB(0.12, 0.2, 1.4, seg, 0, 0, 0, '#6a4e38');
  const g = new THREE.ConeGeometry(0.9, 6.2, level === 'near' ? 8 : 5);
  crown.add(g, '#2f6038', 0, 1.2 + 3.1, 0);
  blob(crown, rng, 0.85, 0, 2.2, 0, '#2f6038', detail, 1.5);
  blob(crown, rng, 0.7, 0, 3.4, 0, '#386c40', detail, 1.6);
  blob(crown, rng, 0.5, 0, 4.7, 0, '#427a4a', detail, 1.6);
  return finishTree(trunk, crown, rng, 1.2, 7.2);
}

interface Placement {
  x: number;
  z: number;
  y: number;
  scale: number;
  rot: number;
  tint: number;
}

const _o = new THREE.Object3D();
const _c = new THREE.Color();

function instance(ctx: WorldCtx, geo: THREE.BufferGeometry, list: Placement[], cast: boolean, name: string): THREE.InstancedMesh | null {
  if (!list.length) return null;
  const mat = ctx.disposer.track(vcMaterial({ roughness: 0.92, flatShading: true }));
  const m = new THREE.InstancedMesh(ctx.disposer.track(geo), mat, list.length);
  m.name = name;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    _o.position.set(p.x, p.y, p.z);
    _o.rotation.set(0, p.rot, 0);
    _o.scale.set(p.scale, p.scale * (0.92 + (p.tint % 1) * 0.16), p.scale);
    _o.updateMatrix();
    m.setMatrixAt(i, _o.matrix);
    const warm = p.tint > 0.93;
    const lum = 0.88 + (p.tint * 7.13 % 1) * 0.24;
    if (warm) _c.setRGB(lum * 1.45, lum * 1.0, lum * 0.5);
    else _c.setRGB(lum * (0.94 + (p.tint * 3.7 % 1) * 0.12), lum, lum * (0.9 + (p.tint * 5.1 % 1) * 0.15));
    m.setColorAt(i, _c);
  }
  m.instanceMatrix.needsUpdate = true;
  if (m.instanceColor) m.instanceColor.needsUpdate = true;
  m.computeBoundingSphere();
  setShadow(m, cast, true);
  m.frustumCulled = true;
  return m;
}

export function buildTrees(ctx: WorldCtx): THREE.Group {
  const root = new THREE.Group();
  root.name = 'trees';
  const rng = mulberry32(2024);
  const kinds: TreeKind[] = ['oak', 'pine', 'cypress'];
  const pickKind = (x: number, z: number, park: boolean): TreeKind => {
    const h = (hashString(`${x.toFixed(1)}|${z.toFixed(1)}`) % 1000) / 1000;
    if (park) return h < 0.5 ? 'oak' : h < 0.85 ? 'pine' : 'cypress';
    return h < 0.8 ? 'oak' : h < 0.92 ? 'cypress' : 'pine';
  };

  // --- gameplay trees (PROPS): detailed + shadow casting
  const near: Record<TreeKind, Placement[]> = { oak: [], pine: [], cypress: [] };
  for (const p of PROPS) {
    if (p.kind !== 'tree') continue;
    const park = p.z < -28;
    const k = pickKind(p.x, p.z, park);
    near[k].push({ x: p.x, z: p.z, y: 0, scale: (p.scale ?? 1) * (k === 'cypress' ? 0.9 : 1), rot: rng() * 6.28, tint: rng() });
  }
  for (const k of kinds) {
    const m = instance(ctx, treeGeometry(k, ctx.detail === 'high' ? 'near' : 'mid'), near[k], ctx.detail === 'high', `trees-${k}`);
    if (m) root.add(m);
  }

  // --- the shared PERIMETER_TREES ring (outside the hedge) + an extra forest band, mid detail
  const ring: Record<TreeKind, Placement[]> = { oak: [], pine: [], cypress: [] };
  for (const t of PERIMETER_TREES) {
    if (Math.max(Math.abs(t.x), Math.abs(t.z)) < 62.5) continue; // inside the walkable square: skip
    const k = pickKind(t.x, t.z, true);
    ring[k].push({ x: t.x, z: t.z, y: outerHeight(t.x, t.z) - 0.15, scale: t.scale * 0.95, rot: rng() * 6.28, tint: rng() });
  }
  const bandCount = ctx.detail === 'high' ? 400 : 180;
  let made = 0;
  let guard = 0;
  while (made < bandCount && guard++ < 20000) {
    const a = rng() * Math.PI * 2;
    const r = 64 + Math.pow(rng(), 1.4) * 80;
    // squarish ring
    const x = Math.cos(a) * r * 1.15;
    const z = Math.sin(a) * r * 1.15;
    if (Math.max(Math.abs(x), Math.abs(z)) < 62.5) continue;
    const k = pickKind(x, z, true);
    ring[k].push({ x, z, y: outerHeight(x, z) - 0.15, scale: 1 + rng() * 1.3, rot: rng() * 6.28, tint: rng() });
    made++;
  }
  for (const k of kinds) {
    const m = instance(ctx, treeGeometry(k, 'mid'), ring[k], false, `forest-${k}`);
    if (m) root.add(m);
  }

  // --- far forest on the hills (very cheap)
  const far: Record<'oak' | 'pine', Placement[]> = { oak: [], pine: [] };
  const farCount = ctx.detail === 'high' ? 600 : 250;
  made = 0;
  guard = 0;
  while (made < farCount && guard++ < 40000) {
    const a = rng() * Math.PI * 2;
    const r = 130 + Math.pow(rng(), 0.8) * 230;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = outerHeight(x, z);
    if (y > 70) continue;
    far[rng() < 0.55 ? 'pine' : 'oak'].push({ x, z, y: y - 0.3, scale: 2.4 + rng() * 2.6, rot: rng() * 6.28, tint: rng() });
    made++;
  }
  for (const k of ['oak', 'pine'] as const) {
    const m = instance(ctx, treeGeometry(k, 'far'), far[k], false, `far-${k}`);
    if (m) root.add(m);
  }

  // --- bushes around building bases / lots
  const bushGeo = new GeoBuilder();
  const brng = mulberry32(555);
  blob(bushGeo, brng, 0.62, 0, 0.42, 0, '#3f7a38', 0, 0.8);
  blob(bushGeo, brng, 0.46, 0.5, 0.33, 0.12, '#4b8a40', 0, 0.8);
  blob(bushGeo, brng, 0.44, -0.42, 0.32, -0.1, '#36692f', 0, 0.8);
  const bg = bushGeo.build();
  bg.computeVertexNormals();
  jitterFaces(bg, brng, 0.1);
  const bushes: Placement[] = [];
  const addBush = (x: number, z: number) => {
    if (!isOpenGrass(x, z, 0.5)) return;
    bushes.push({ x, z, y: 0, scale: 0.8 + brng() * 0.7, rot: brng() * 6.28, tint: brng() });
  };
  for (const b of BUILDINGS) {
    for (const side of [-1, 1]) {
      for (let z = b.z - b.d / 2 + 0.5; z < b.z + b.d / 2; z += 2.3 + brng() * 1.5) {
        if (brng() < 0.6) addBush(b.x + side * (b.w / 2 + 0.9), z);
      }
    }
    const backZ = b.door === 'S' ? b.z - b.d / 2 - 0.9 : b.z + b.d / 2 + 0.9;
    for (let x = b.x - b.w / 2 + 1; x < b.x + b.w / 2; x += 2.6 + brng() * 2) if (brng() < 0.7) addBush(x, backZ);
  }
  for (let i = 0; i < 70; i++) addBush(-56 + brng() * 112, -56 + brng() * 112);
  // hugging the hedge
  for (let t = -56; t < 56; t += 3.5 + brng() * 4) {
    addBush(t, -57); addBush(t, 57); addBush(-57, t); addBush(57, t);
  }
  const bm = instance(ctx, bg, bushes, false, 'bushes');
  if (bm) {
    bm.castShadow = ctx.detail === 'high';
    root.add(bm);
  }
  return root;
}
