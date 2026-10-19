import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CROSS_ROAD, FOUNTAIN, POND, ROAD, WORLD_BOUNDS, BUILDINGS } from '@pixels/shared';
import { GeoBuilder, setShadow, vcMaterial } from '../gfx/geo';
import { makeCanvas, mulberry32, toTexture } from '../gfx/canvasUtil';
import { FLAT_EXTENT, fbm2, outerHeight } from '../gfx/terrain';
import { KIOSK_COURT, PARK_PATH_RECT, PLAZA_RECT, PLAYGROUND_RECT, SIDEWALK_H, SIDEWALK_RECTS, type Rect } from '../logic/layout';
import { rectGeometry, type WorldCtx } from './ctx';

const CROSSWALKS_X = [-42, -20, -6.75, 6.75, 21, 42];
export const CROSSWALK_X = CROSSWALKS_X;

function markingsTexture(ctx: WorldCtx): { main: THREE.CanvasTexture; cross: THREE.CanvasTexture } {
  const P = 16;
  // ---- main road: x -59..59 (118 m), z -5..5
  const W = 118 * P;
  const H = 10 * P;
  const { canvas, ctx: c } = makeCanvas(W, H);
  const rng = mulberry32(5);
  const X = (x: number) => (x + 59) * P;
  const white = (a = 0.92) => `rgba(236,236,226,${a})`;
  c.clearRect(0, 0, W, H);
  // centre dashes
  c.fillStyle = white(0.9);
  for (let x = -58; x < 58; x += 6) {
    const dx0 = x;
    const dx1 = x + 3;
    if (CROSSWALKS_X.some((cx) => dx1 > cx - 2.2 && dx0 < cx + 2.2)) continue;
    c.fillRect(X(dx0), H / 2 - 1.5, 3 * P, 3);
  }
  // edge lines (north edge opens at the cross street)
  const edge = (x0: number, x1: number, y: number) => {
    c.fillStyle = white(0.85);
    // break at crosswalks
    let a = x0;
    for (const cx of CROSSWALKS_X.filter((v) => v > x0 && v < x1).sort((p, q) => p - q)) {
      c.fillRect(X(a), y - 1, X(cx - 1.6) - X(a), 2);
      a = cx + 1.6;
    }
    c.fillRect(X(a), y - 1, X(x1) - X(a), 2);
  };
  edge(-58.5, -5.2, 0.6 * P);
  edge(5.2, 58.5, 0.6 * P);
  edge(-58.5, 58.5, H - 0.6 * P);
  // zebra crossings
  for (const cx of CROSSWALKS_X) {
    for (let z = -4.1; z < 4.1; z += 0.9) {
      c.fillStyle = white(0.78 + rng() * 0.18);
      c.fillRect(X(cx - 1.4), (z + 5) * P, 2.8 * P, 0.5 * P);
    }
    // stop lines
    c.fillStyle = white(0.8);
    c.fillRect(X(cx - 2.2), 0.7 * P, 0.35 * P, 4.1 * P - 0.7 * P - 0.1 * P);
  }
  // wear
  for (let i = 0; i < 1500; i++) {
    c.clearRect(rng() * W, rng() * H, 1 + rng() * 3, 1 + rng() * 3);
  }
  // ---- cross road: x -5..5, z -30..-5 (25 m)
  const W2 = 10 * P;
  const H2 = 25 * P;
  const { canvas: c2, ctx: d } = makeCanvas(W2, H2);
  const Z = (z: number) => (z + 30) * P;
  d.fillStyle = white(0.9);
  for (let z = -29; z < -11; z += 6) d.fillRect(W2 / 2 - 1.5, Z(z), 3, 3 * P);
  d.fillStyle = white(0.85);
  d.fillRect(0.6 * P - 1, 0, 2, H2);
  d.fillRect(W2 - 0.6 * P - 1, 0, 2, H2);
  for (let x = -4.1; x < 4.1; x += 0.9) {
    d.fillStyle = white(0.8 + rng() * 0.15);
    d.fillRect((x + 5) * P, Z(-9.2), 0.5 * P, 2.7 * P);
  }
  for (let i = 0; i < 400; i++) d.clearRect(rng() * W2, rng() * H2, 1 + rng() * 3, 1 + rng() * 3);
  return {
    main: ctx.disposer.track(toTexture(canvas, { repeat: false, aniso: 8 })),
    cross: ctx.disposer.track(toTexture(c2, { repeat: false, aniso: 8 })),
  };
}

function buildTerrain(ctx: WorldCtx): THREE.Mesh {
  const SIZE = 1000;
  const SEG = ctx.detail === 'high' ? 150 : 100;
  const g = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  g.rotateX(-Math.PI / 2);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const c = new THREE.Color();
  const lightG = new THREE.Color('#79b457');
  const darkG = new THREE.Color('#4d8a3a');
  const dry = new THREE.Color('#8fa85a');
  const rock = new THREE.Color('#8a8479');
  const high = new THREE.Color('#c4c8d0');
  // grass texture average (linear) so rock/snow colours can be reached through the textured material
  const texAvg = new THREE.Color('#5c963e');
  const hs: number[] = new Array(n);
  for (let i = 0; i < n; i++) hs[i] = outerHeight(pos.getX(i), pos.getZ(i));
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = hs[i];
    pos.setY(i, h);
    const nz = fbm2(x * 0.03 + 3, z * 0.03 + 9);
    c.copy(darkG).lerp(lightG, nz);
    c.lerp(dry, Math.max(0, fbm2(x * 0.011, z * 0.011 + 40) - 0.55) * 1.6);
    const e = 6;
    const sl = Math.hypot(outerHeight(x + e, z) - outerHeight(x - e, z), outerHeight(x, z + e) - outerHeight(x, z - e)) / (2 * e);
    const rockness = Math.min(1, Math.max(0, (sl - 0.42) * 2.2 + (h - 40) / 70));
    c.lerp(rock, rockness);
    const snow = Math.min(1, Math.max(0, (h - 85) / 40));
    c.lerp(high, snow);
    // express as multiplier of the grass texture
    col[i * 3] = c.r / texAvg.r;
    col[i * 3 + 1] = c.g / texAvg.g;
    col[i * 3 + 2] = c.b / texAvg.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  const map = ctx.rep(ctx.tex.grass, SIZE / 8, SIZE / 8);
  const mat = ctx.disposer.track(new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: 1, metalness: 0 }));
  const m = new THREE.Mesh(g, mat);
  ctx.disposer.track(g);
  m.position.y = -0.01;
  m.receiveShadow = true;
  m.name = 'terrain';
  return m;
}

function skirt(b: GeoBuilder, r: Rect, h: number, color: string, thick = 0.12): void {
  const w = r.maxX - r.minX;
  const d = r.maxZ - r.minZ;
  const cx = (r.minX + r.maxX) / 2;
  const cz = (r.minZ + r.maxZ) / 2;
  b.boxB(w, h, thick, cx, 0, r.minZ - thick / 2 + 0.01, color);
  b.boxB(w, h, thick, cx, 0, r.maxZ + thick / 2 - 0.01, color);
  b.boxB(thick, h, d, r.minX - thick / 2 + 0.01, 0, cz, color);
  b.boxB(thick, h, d, r.maxX + thick / 2 - 0.01, 0, cz, color);
}

export function buildGround(ctx: WorldCtx): THREE.Group {
  const root = new THREE.Group();
  root.name = 'ground';
  const { tex, disposer } = ctx;

  root.add(buildTerrain(ctx));

  // ---------------------------------------------------------------- roads
  const asphaltMain = ctx.rep(tex.asphalt, 118 / 4, 10 / 4);
  const asphaltCross = ctx.rep(tex.asphalt, 10 / 4, 25 / 4);
  const asphaltMatMain = disposer.track(new THREE.MeshStandardMaterial({ map: asphaltMain, roughness: 0.92, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  const asphaltMatCross = disposer.track(new THREE.MeshStandardMaterial({ map: asphaltCross, roughness: 0.92, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  const roadMain = new THREE.Mesh(disposer.track(new THREE.PlaneGeometry(118, ROAD.maxZ - ROAD.minZ)), asphaltMatMain);
  roadMain.rotation.x = -Math.PI / 2;
  roadMain.position.set(0, 0.012, 0);
  const roadCross = new THREE.Mesh(disposer.track(new THREE.PlaneGeometry(CROSS_ROAD.maxX - CROSS_ROAD.minX, CROSS_ROAD.maxZ - CROSS_ROAD.minZ)), asphaltMatCross);
  roadCross.rotation.x = -Math.PI / 2;
  roadCross.position.set(0, 0.012, (CROSS_ROAD.minZ + CROSS_ROAD.maxZ) / 2);
  setShadow(roadMain, false, true);
  setShadow(roadCross, false, true);
  root.add(roadMain, roadCross);

  const mk = markingsTexture(ctx);
  const decalMat = (map: THREE.Texture) =>
    disposer.track(new THREE.MeshStandardMaterial({ map, transparent: true, roughness: 0.8, metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  const decMain = new THREE.Mesh(disposer.track(new THREE.PlaneGeometry(118, 10)), decalMat(mk.main));
  decMain.rotation.x = -Math.PI / 2;
  decMain.position.set(0, 0.016, 0);
  const decCross = new THREE.Mesh(disposer.track(new THREE.PlaneGeometry(10, 25)), decalMat(mk.cross));
  decCross.rotation.x = -Math.PI / 2;
  decCross.position.set(0, 0.016, (CROSS_ROAD.minZ + CROSS_ROAD.maxZ) / 2);
  decMain.receiveShadow = true;
  decCross.receiveShadow = true;
  root.add(decMain, decCross);

  // ------------------------------------------------------------ sidewalks
  const swGeos = SIDEWALK_RECTS.map((r) => rectGeometry(r.minX, r.maxX, r.minZ, r.maxZ, SIDEWALK_H, 4.8));
  const swGeo = disposer.track(mergeGeometries(swGeos)!);
  swGeos.forEach((g) => g.dispose());
  const swMat = disposer.track(new THREE.MeshStandardMaterial({ map: tex.sidewalk, roughness: 0.9, metalness: 0 }));
  const sw = new THREE.Mesh(swGeo, swMat);
  sw.receiveShadow = true;
  root.add(sw);

  // plaza + kiosk court (same paving)
  const plazaGeos = [PLAZA_RECT, KIOSK_COURT].map((r) => rectGeometry(r.minX, r.maxX, r.minZ, r.maxZ, SIDEWALK_H, 6));
  const plazaGeo = disposer.track(mergeGeometries(plazaGeos)!);
  plazaGeos.forEach((g) => g.dispose());
  const plazaMat = disposer.track(new THREE.MeshStandardMaterial({ map: tex.plaza, roughness: 0.88, metalness: 0 }));
  const plaza = new THREE.Mesh(plazaGeo, plazaMat);
  plaza.receiveShadow = true;
  root.add(plaza);

  // curbs / skirts
  const curb = new GeoBuilder();
  for (const r of SIDEWALK_RECTS) skirt(curb, r, SIDEWALK_H, '#a6a39a');
  skirt(curb, PLAZA_RECT, SIDEWALK_H, '#b3ab9a');
  skirt(curb, KIOSK_COURT, SIDEWALK_H, '#b3ab9a');
  const curbGeo = disposer.track(curb.build());
  const curbMesh = new THREE.Mesh(curbGeo, disposer.track(vcMaterial({ roughness: 0.9 })));
  curbMesh.receiveShadow = true;
  root.add(curbMesh);

  // plaza decoration: ring pattern around the fountain + border band
  const deco = new GeoBuilder();
  const ringY = SIDEWALK_H + 0.004;
  const ringMat = (inner: number, outer: number, color: string) => {
    const g = new THREE.RingGeometry(inner, outer, 64, 1);
    g.rotateX(-Math.PI / 2);
    deco.add(g, color, FOUNTAIN.x, ringY, FOUNTAIN.z);
  };
  ringMat(FOUNTAIN.r + 0.2, FOUNTAIN.r + 1.6, '#8e8576');
  ringMat(FOUNTAIN.r + 1.6, FOUNTAIN.r + 1.85, '#e9e0cc');
  ringMat(FOUNTAIN.r + 1.85, FOUNTAIN.r + 3.6, '#cbbfa6');
  ringMat(FOUNTAIN.r + 3.6, FOUNTAIN.r + 3.85, '#8e8576');
  // spokes
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r0 = FOUNTAIN.r + 1.85;
    const len = 1.75;
    deco.box(0.14, 0.004, len, FOUNTAIN.x + Math.sin(a) * (r0 + len / 2), ringY, FOUNTAIN.z + Math.cos(a) * (r0 + len / 2), '#8e8576', { ry: a });
  }
  // border band along the plaza's open edges
  const bandW = 0.5;
  deco.box(PLAZA_RECT.maxX - PLAZA_RECT.minX - bandW * 2, 0.004, bandW, (PLAZA_RECT.minX + PLAZA_RECT.maxX) / 2, ringY, PLAZA_RECT.maxZ - bandW / 2, '#8e8576');
  deco.box(bandW, 0.004, PLAZA_RECT.maxZ - PLAZA_RECT.minZ, PLAZA_RECT.minX + bandW / 2, ringY, (PLAZA_RECT.minZ + PLAZA_RECT.maxZ) / 2, '#8e8576');
  deco.box(bandW, 0.004, PLAZA_RECT.maxZ - PLAZA_RECT.minZ, PLAZA_RECT.maxX - bandW / 2, ringY, (PLAZA_RECT.minZ + PLAZA_RECT.maxZ) / 2, '#8e8576');
  const decoGeo = disposer.track(deco.build());
  const decoMesh = new THREE.Mesh(decoGeo, disposer.track(vcMaterial({ roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })));
  decoMesh.receiveShadow = true;
  root.add(decoMesh);

  // ---------------------------------------------------- park paths (gravel)
  const paths: Rect[] = [
    PARK_PATH_RECT,
    { minX: 2.5, maxX: 10, minZ: -45.6, maxZ: -42.4 },
    { minX: -12.5, maxX: -2.5, minZ: -45.6, maxZ: -42.4 },
    { minX: 9.4, maxX: 14.6, minZ: -46.6, maxZ: -41.4 },
  ];
  const pg = paths.map((r) => rectGeometry(r.minX, r.maxX, r.minZ, r.maxZ, 0.02, 3));
  const pathGeo = disposer.track(mergeGeometries(pg)!);
  pg.forEach((g) => g.dispose());
  const pathMesh = new THREE.Mesh(pathGeo, disposer.track(new THREE.MeshStandardMaterial({ map: tex.gravel, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })));
  pathMesh.receiveShadow = true;
  root.add(pathMesh);
  // path edging stones
  const edge = new GeoBuilder();
  const rngE = mulberry32(77);
  for (const r of paths.slice(0, 3)) {
    const horizontal = r.maxX - r.minX > r.maxZ - r.minZ;
    const len = horizontal ? r.maxX - r.minX : r.maxZ - r.minZ;
    for (let t = 0.4; t < len; t += 0.9 + rngE() * 0.3) {
      for (const side of [0, 1]) {
        const jitter = (rngE() - 0.5) * 0.12;
        const x = horizontal ? r.minX + t : side ? r.maxX + 0.1 + jitter : r.minX - 0.1 + jitter;
        const z = horizontal ? (side ? r.maxZ + 0.1 + jitter : r.minZ - 0.1 + jitter) : r.minZ + t;
        if (horizontal && Math.abs(x) < 3) continue; // main path crossing
        if (!horizontal && Math.abs(z + 44) < 1.8) continue;
        const v = 120 + rngE() * 60;
        edge.box(0.32, 0.12, 0.32, x, 0.04, z, `rgb(${v},${v - 4},${v - 12})`, { ry: rngE() * 3 });
      }
    }
  }
  const edgeMesh = new THREE.Mesh(disposer.track(edge.build()), disposer.track(vcMaterial({ roughness: 0.95 })));
  setShadow(edgeMesh, true, true);
  root.add(edgeMesh);

  // ------------------------------------------------------------ playground
  const pr = PLAYGROUND_RECT;
  const rubberTex = ctx.rep(tex.rubber, (pr.maxX - pr.minX) / 3, (pr.maxZ - pr.minZ) / 3);
  const rubber = new THREE.Mesh(
    disposer.track(rectGeometry(pr.minX, pr.maxX, pr.minZ, pr.maxZ, 0.02, 3)),
    disposer.track(new THREE.MeshStandardMaterial({ map: tex.rubber, color: '#9fb38a', roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })),
  );
  void rubberTex;
  rubber.receiveShadow = true;
  root.add(rubber);
  const border = new GeoBuilder();
  const bw = 0.16;
  border.boxB(pr.maxX - pr.minX + bw, 0.22, bw, (pr.minX + pr.maxX) / 2, 0, pr.minZ, '#7a5a3a');
  border.boxB(pr.maxX - pr.minX + bw, 0.22, bw, (pr.minX + pr.maxX) / 2, 0, pr.maxZ, '#7a5a3a');
  border.boxB(bw, 0.22, pr.maxZ - pr.minZ, pr.minX, 0, (pr.minZ + pr.maxZ) / 2, '#7a5a3a');
  border.boxB(bw, 0.22, pr.maxZ - pr.minZ, pr.maxX, 0, (pr.minZ + pr.maxZ) / 2, '#7a5a3a');
  const borderMesh = new THREE.Mesh(disposer.track(border.build()), disposer.track(vcMaterial()));
  setShadow(borderMesh, true, true);
  root.add(borderMesh);

  // ------------------------------------------------------- boundary hedge
  const HW = 1.2;
  const HH = 1.15;
  const ext = WORLD_BOUNDS.maxX + 0.6 + HW / 2;
  const hedgeSpec: { x: number; z: number; w: number; d: number }[] = [
    { x: 0, z: -(WORLD_BOUNDS.maxZ + 0.6), w: ext * 2 + HW, d: HW },
    { x: 0, z: WORLD_BOUNDS.maxZ + 0.6, w: ext * 2 + HW, d: HW },
    { x: -(WORLD_BOUNDS.maxX + 0.6), z: 0, w: HW, d: ext * 2 - HW },
    { x: WORLD_BOUNDS.maxX + 0.6, z: 0, w: HW, d: ext * 2 - HW },
  ];
  for (const h of hedgeSpec) {
    const hm = disposer.track(new THREE.MeshStandardMaterial({ map: ctx.rep(tex.hedge, Math.max(h.w, h.d) / 1.6, 1), roughness: 1, metalness: 0 }));
    const geo = disposer.track(new THREE.BoxGeometry(h.w, HH, h.d, 1, 1, 1));
    // rotate texture so it runs along the long axis
    if (h.d > h.w) {
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getY(i), uv.getX(i));
    }
    const m = new THREE.Mesh(geo, hm);
    m.position.set(h.x, HH / 2, h.z);
    setShadow(m, true, true);
    root.add(m);
    // rounded top ridge
    const top = new THREE.Mesh(disposer.track(new THREE.CylinderGeometry(HW * 0.42, HW * 0.42, Math.max(h.w, h.d) - HW, 8, 1)), hm);
    top.rotation.z = Math.PI / 2;
    if (h.d > h.w) top.rotation.set(Math.PI / 2, 0, 0);
    top.position.set(h.x, HH, h.z);
    top.scale.set(1, 1, 1);
    setShadow(top, true, false);
    root.add(top);
  }

  // road end barriers
  const bar = new GeoBuilder();
  for (const sx of [-1, 1]) {
    const x = sx * (WORLD_BOUNDS.maxX - 1.4);
    bar.boxB(0.16, 1.2, 0.16, x, 0, -4.5, '#d9d9d9');
    bar.boxB(0.16, 1.2, 0.16, x, 0, 4.5, '#d9d9d9');
    for (let i = 0; i < 10; i++) bar.box(0.1, 0.18, 0.9, x, 1.0, -4.5 + 0.45 + i * 0.9, i % 2 ? '#f2f2f2' : '#d23a2e');
    bar.cylB(0.05, 0.05, 0.1, 8, x, 1.2, -4.5, '#ffb400');
    bar.cylB(0.05, 0.05, 0.1, 8, x, 1.2, 4.5, '#ffb400');
  }
  const barMesh = new THREE.Mesh(disposer.track(bar.build()), disposer.track(vcMaterial({ roughness: 0.6 })));
  setShadow(barMesh, true, true);
  root.add(barMesh);

  void POND; void BUILDINGS; void FLAT_EXTENT;
  return root;
}
