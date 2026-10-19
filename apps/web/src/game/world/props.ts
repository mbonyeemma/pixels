import * as THREE from 'three';
import { FOUNTAIN, GAZEBO, PLAYGROUND, POND, PROPS, BUILDINGS } from '@pixels/shared';
import { GeoBuilder, jitterFaces, setShadow, vcMaterial } from '../gfx/geo';
import { createParticles } from '../gfx/particles';
import { mulberry32 } from '../logic/palette';
import { GAZEBO_H, GAZEBO_PLATFORM, SIDEWALK_H } from '../logic/layout';
import type { WorldCtx } from './ctx';

export interface PropsResult {
  root: THREE.Group;
  /** world positions of the lantern bulbs (for the real lights near the player) */
  lamps: THREE.Vector3[];
}

const lathe = (pts: [number, number][], seg: number): THREE.LatheGeometry => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);

// ------------------------------------------------------------------ lamps
function buildLamps(ctx: WorldCtx, root: THREE.Group): THREE.Vector3[] {
  const lamps = PROPS.filter((p) => p.kind === 'lamp');
  const post = new GeoBuilder();
  const IRON = '#2c3038';
  post.cylB(0.26, 0.3, 0.12, 10, 0, 0, 0, '#555a62');
  post.cylB(0.17, 0.22, 0.5, 10, 0, 0.12, 0, IRON);
  post.cylB(0.07, 0.1, 4.2, 8, 0, 0.62, 0, IRON);
  post.cylB(0.11, 0.11, 0.1, 8, 0, 1.4, 0, '#3b414a');
  post.cylB(0.09, 0.09, 0.08, 8, 0, 4.7, 0, '#3b414a');
  // curved arm toward -z
  post.box(0.08, 0.08, 0.8, 0, 4.85, -0.35, IRON, { rx: 0.0 });
  post.box(0.08, 0.08, 0.7, 0, 4.9, -0.95, IRON);
  post.box(0.06, 0.4, 0.06, 0, 4.7, -0.15, IRON, { rx: 0.7 });
  // lantern housing
  post.cylB(0.28, 0.2, 0.1, 8, 0, 4.9, -1.3, IRON);
  post.cylB(0.0, 0.3, 0.22, 8, 0, 5.0, -1.3, '#3b414a');
  post.cylB(0.03, 0.03, 0.12, 6, 0, 5.2, -1.3, IRON);
  const body = new THREE.Mesh(ctx.disposer.track(post.build()), ctx.disposer.track(vcMaterial({ roughness: 0.55, metalness: 0.4 })));
  const bulbGeo = ctx.disposer.track(new THREE.CylinderGeometry(0.2, 0.15, 0.36, 8));
  const bulbMat = ctx.disposer.track(new THREE.MeshBasicMaterial({ color: '#d9d4c0', toneMapped: false }));
  const glassGeo = ctx.disposer.track(new THREE.CylinderGeometry(0.235, 0.18, 0.4, 8, 1, true));
  const glassMat = ctx.disposer.track(new THREE.MeshStandardMaterial({ color: '#f5f1e0', transparent: true, opacity: 0.25, roughness: 0.2, side: THREE.DoubleSide, depthWrite: false }));
  const n = lamps.length;
  const bodies = new THREE.InstancedMesh(body.geometry, body.material, n);
  const bulbs = new THREE.InstancedMesh(bulbGeo, bulbMat, n);
  const glass = new THREE.InstancedMesh(glassGeo, glassMat, n);
  const o = new THREE.Object3D();
  const out: THREE.Vector3[] = [];
  const poolPos: THREE.Vector3[] = [];
  lamps.forEach((l, i) => {
    o.position.set(l.x, 0, l.z);
    o.rotation.set(0, l.rot ?? 0, 0);
    o.scale.set(1, 1, 1);
    o.updateMatrix();
    bodies.setMatrixAt(i, o.matrix);
    const rot = l.rot ?? 0;
    const lx = l.x - Math.sin(rot) * 1.3;
    const lz = l.z - Math.cos(rot) * 1.3;
    out.push(new THREE.Vector3(lx, 4.95, lz));
    poolPos.push(new THREE.Vector3(lx, 0, lz));
    o.position.set(lx, 4.88, lz);
    o.rotation.set(0, 0, 0);
    o.updateMatrix();
    bulbs.setMatrixAt(i, o.matrix);
    o.position.y = 4.9;
    o.updateMatrix();
    glass.setMatrixAt(i, o.matrix);
  });
  setShadow(bodies, true, true);
  bulbs.frustumCulled = false;
  bodies.frustumCulled = false;
  glass.frustumCulled = false;
  root.add(bodies, bulbs, glass);

  // halo sprites + light pools on the ground (cheap fake lighting for every lamp)
  const halo = createParticles({
    count: n,
    map: ctx.tex.softCircle,
    color: '#ffc77a',
    additive: true,
    seedFn: (i, s) => { s[0] = out[i].x; s[1] = out[i].y; s[2] = out[i].z; },
    motion: 'center = seed.xyz; size = 3.2; alpha = uLight * 0.8;',
  });
  halo.material.depthTest = true;
  halo.material.uniforms.uLight.value = 0;
  root.add(halo.mesh);

  const poolGeo = ctx.disposer.track(new THREE.PlaneGeometry(1, 1));
  poolGeo.rotateX(-Math.PI / 2);
  const poolMat = ctx.disposer.track(new THREE.MeshBasicMaterial({ map: ctx.tex.softCircle, color: '#ffb35a', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, fog: false }));
  const pools = new THREE.InstancedMesh(poolGeo, poolMat, n);
  poolPos.forEach((p, i) => {
    o.position.set(p.x, 0.07, p.z);
    o.rotation.set(0, 0, 0);
    o.scale.set(9, 1, 9);
    o.updateMatrix();
    pools.setMatrixAt(i, o.matrix);
  });
  pools.frustumCulled = false;
  pools.renderOrder = 2;
  root.add(pools);

  ctx.updaters.push((_dt, time, env) => {
    const on = env.lampOn;
    halo.update(time, on);
    poolMat.opacity = on * 0.55;
    pools.visible = on > 0.01;
    halo.mesh.visible = on > 0.01;
    // bulbs: dull white by day, warm and over-bright at night
    const k = 0.55 + on * 1.25;
    bulbMat.color.setRGB(0.78 + on * 0.22, 0.74 + on * 0.1, 0.62 - on * 0.2).multiplyScalar(k);
    glassMat.opacity = 0.2 + on * 0.25;
  });
  return out;
}

// ----------------------------------------------------------------- benches
function buildBenches(ctx: WorldCtx, root: THREE.Group): void {
  const list = PROPS.filter((p) => p.kind === 'bench');
  if (!list.length) return;
  const b = new GeoBuilder();
  const WOOD = '#9a6a3c';
  const WOOD2 = '#8a5c32';
  const IRON = '#2f343c';
  for (let i = 0; i < 4; i++) b.box(1.8, 0.045, 0.1, 0, 0.46, -0.2 + i * 0.13, i % 2 ? WOOD : WOOD2);
  for (let i = 0; i < 3; i++) b.box(1.8, 0.1, 0.035, 0, 0.62 + i * 0.15, 0.27 - i * 0.02, i % 2 ? WOOD : WOOD2, { rx: -0.18 });
  for (const sx of [-1, 1]) {
    b.box(0.05, 0.46, 0.5, sx * 0.84, 0.23, 0.0, IRON);
    b.box(0.05, 0.5, 0.05, sx * 0.84, 0.7, 0.27, IRON, { rx: -0.18 });
    b.box(0.07, 0.05, 0.5, sx * 0.84, 0.66, -0.05, IRON);
  }
  const geo = ctx.disposer.track(b.build());
  const m = new THREE.InstancedMesh(geo, ctx.disposer.track(vcMaterial({ roughness: 0.8 })), list.length);
  const o = new THREE.Object3D();
  list.forEach((p, i) => {
    o.position.set(p.x, p.x > 20 || p.z < -5 || p.z > 10 ? 0 : 0, p.z);
    o.rotation.set(0, p.rot ?? 0, 0);
    o.updateMatrix();
    m.setMatrixAt(i, o.matrix);
  });
  setShadow(m, true, true);
  m.frustumCulled = false;
  root.add(m);
}

// ---------------------------------------------------------------- fountain
function buildFountain(ctx: WorldCtx, root: THREE.Group): void {
  const g = new THREE.Group();
  g.position.set(FOUNTAIN.x, SIDEWALK_H, FOUNTAIN.z);
  const stone = new GeoBuilder();
  const S1 = '#aaa69b';
  const S2 = '#bcb8ac';
  const S3 = '#928e84';
  // basin: outer wall, inner wall, rim cap, floor
  stone.add(lathe([[FOUNTAIN.r - 0.45, 0], [FOUNTAIN.r, 0], [FOUNTAIN.r, 0.52], [FOUNTAIN.r - 0.45, 0.52]], 40), S1);
  stone.add(lathe([[FOUNTAIN.r - 0.45, 0.52], [FOUNTAIN.r + 0.08, 0.52], [FOUNTAIN.r + 0.08, 0.62], [FOUNTAIN.r - 0.53, 0.62], [FOUNTAIN.r - 0.53, 0.52]], 40), S2);
  stone.add(lathe([[0, 0.02], [FOUNTAIN.r - 0.45, 0.02]], 40), '#35616b');
  // pedestal + tiers
  stone.add(lathe([[0.0, 0], [0.75, 0], [0.7, 0.35], [0.45, 0.5], [0.34, 1.0], [0.34, 1.35]], 20), S1);
  stone.add(lathe([[0.34, 1.35], [1.75, 1.45], [1.8, 1.62], [1.6, 1.58], [0.2, 1.52]], 28), S2);
  stone.add(lathe([[0.2, 1.52], [0.26, 2.15], [0.34, 2.3]], 14), S1);
  stone.add(lathe([[0.3, 2.3], [1.05, 2.4], [1.1, 2.55], [0.95, 2.52], [0.1, 2.46]], 24), S2);
  stone.add(lathe([[0.1, 2.46], [0.14, 2.9], [0.07, 3.1]], 10), S3);
  stone.sphere(0.16, 10, 8, 0, 3.14, 0, '#c8a24a');
  const sg = stone.build();
  const sm = new THREE.Mesh(ctx.disposer.track(sg), ctx.disposer.track(vcMaterial({ roughness: 0.82 })));
  setShadow(sm, true, true);
  g.add(sm);
  // water surface
  const wn = ctx.rep(ctx.tex.waterNormal, 3, 3);
  const wmat = ctx.disposer.track(new THREE.MeshStandardMaterial({ color: '#4aa8c4', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.82, normalMap: wn, normalScale: new THREE.Vector2(0.55, 0.55), emissive: '#0d3a4a', emissiveIntensity: 0.5 }));
  const water = new THREE.Mesh(ctx.disposer.track(new THREE.CircleGeometry(FOUNTAIN.r - 0.45, 40)), wmat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0.44;
  water.receiveShadow = true;
  g.add(water);
  // upper tier water + lower tier water films
  const tier1 = new THREE.Mesh(ctx.disposer.track(new THREE.CircleGeometry(1.55, 28)), wmat);
  tier1.rotation.x = -Math.PI / 2;
  tier1.position.y = 1.56;
  const tier2 = new THREE.Mesh(ctx.disposer.track(new THREE.CircleGeometry(0.95, 24)), wmat);
  tier2.rotation.x = -Math.PI / 2;
  tier2.position.y = 2.5;
  g.add(tier1, tier2);
  // ripple rings
  const ringGeo = ctx.disposer.track(new THREE.RingGeometry(0.94, 1, 48));
  const rings: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const rm = ctx.disposer.track(new THREE.MeshBasicMaterial({ color: '#e8f8ff', transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide }));
    const r = new THREE.Mesh(ringGeo, rm);
    r.rotation.x = -Math.PI / 2;
    r.position.y = 0.455;
    g.add(r);
    rings.push(r);
  }
  // jets: central column + arcs from the top bowl + drips from the tier lips
  const jets = createParticles({
    count: 260,
    map: ctx.tex.softCircle,
    color: '#cfefff',
    additive: false,
    motion: `
      float kind = seed.w;
      float life = 1.0;
      float ph = fract(seed.x + t * (0.35 + seed.y * 0.25));
      float g = 9.8;
      if (kind < 0.25) {
        // central jet going up and falling back
        float vy = 4.6 + seed.y * 1.2;
        float T = 2.0 * vy / g;
        float s = ph * T;
        float a = seed.z * 6.2831;
        float rr = 0.05 + seed.y * 0.25 * s;
        center = vec3(cos(a) * rr, 3.1 + vy * s - 0.5 * g * s * s, sin(a) * rr);
        size = 0.09; alpha = 0.9 * (1.0 - ph * 0.3);
      } else if (kind < 0.7) {
        // arcs from the top bowl out to the middle tier
        float vy = 2.1 + seed.y * 1.4;
        float vr = 0.9 + seed.z * 0.9;
        float y0 = 2.55;
        float T = (vy + sqrt(vy * vy + 2.0 * g * (y0 - 1.6))) / g;
        float s = ph * T;
        float a = floor(seed.z * 8.0) / 8.0 * 6.2831 + seed.x * 0.15;
        center = vec3(cos(a) * vr * s, y0 + vy * s - 0.5 * g * s * s, sin(a) * vr * s);
        size = 0.075; alpha = 0.85;
      } else {
        // arcs from the middle tier lip into the basin
        float vy = 0.8 + seed.y * 1.2;
        float vr = 1.4 + seed.z * 0.9;
        float y0 = 1.6;
        float T = (vy + sqrt(vy * vy + 2.0 * g * (y0 - 0.46))) / g;
        float s = ph * T;
        float a = floor(seed.z * 12.0) / 12.0 * 6.2831 + seed.x * 0.1;
        center = vec3(cos(a) * (1.6 + vr * s), y0 + vy * s - 0.5 * g * s * s, sin(a) * (1.6 + vr * s));
        size = 0.07; alpha = 0.8;
      }
    `,
    seedFn: (_i, s) => { s[3] = s[3]; },
  });
  jets.mesh.position.set(0, 0, 0);
  g.add(jets.mesh);

  ctx.updaters.push((_dt, time, env) => {
    wn.offset.set(time * 0.012, time * 0.018);
    jets.update(time, 0.35 + env.day * 0.65);
    for (let i = 0; i < rings.length; i++) {
      const ph = (time * 0.35 + i / rings.length) % 1;
      const rad = 0.6 + ph * (FOUNTAIN.r - 1.3);
      rings[i].scale.set(rad, rad, 1);
      (rings[i].material as THREE.MeshBasicMaterial).opacity = (1 - ph) * 0.32 * (0.4 + 0.6 * env.day);
    }
    wmat.emissiveIntensity = 0.25 + env.night * 0.9;
  });
  root.add(g);

  // night glow under the water
  void FOUNTAIN;
}

// -------------------------------------------------------------------- pond
function buildPond(ctx: WorldCtx, root: THREE.Group): void {
  const g = new THREE.Group();
  g.position.set(POND.x, 0, POND.z);
  const bank = new GeoBuilder();
  bank.add(lathe([[5.0, 0.0], [5.35, 0.12], [5.8, 0.3], [6.1, 0.34]], 48), '#5d4a34');
  bank.add(lathe([[6.1, 0.34], [6.6, 0.32], [7.4, 0.12], [8.2, 0.0]], 48), '#5e9a48');
  bank.add(lathe([[0, 0.0], [5.0, 0.0]], 48), '#1d3c42');
  const bg = bank.build();
  bg.computeVertexNormals();
  const bankMesh = new THREE.Mesh(ctx.disposer.track(bg), ctx.disposer.track(vcMaterial({ roughness: 1 })));
  bankMesh.receiveShadow = true;
  g.add(bankMesh);

  const wn = ctx.rep(ctx.tex.waterNormal, 4, 4);
  const wmat = ctx.disposer.track(new THREE.MeshStandardMaterial({ color: '#2f7f8f', roughness: 0.06, metalness: 0.15, transparent: true, opacity: 0.88, normalMap: wn, normalScale: new THREE.Vector2(0.45, 0.45), emissive: '#06222c', emissiveIntensity: 0.4 }));
  const water = new THREE.Mesh(ctx.disposer.track(new THREE.CircleGeometry(5.4, 48)), wmat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0.2;
  water.receiveShadow = true;
  g.add(water);

  // rocks on the shore
  const rng = mulberry32(909);
  const rocks = new GeoBuilder();
  for (let i = 0; i < 34; i++) {
    const a = (i / 34) * Math.PI * 2 + rng() * 0.15;
    const r = 5.55 + rng() * 0.55;
    const s = 0.28 + rng() * 0.38;
    const ico = new THREE.IcosahedronGeometry(s, 0);
    const v = 110 + rng() * 60;
    rocks.add(ico, `rgb(${v},${v - 3},${v - 10})`, Math.cos(a) * r, 0.16 + s * 0.15, Math.sin(a) * r, { ry: rng() * 6, sy: 0.65 + rng() * 0.3, sx: 1 + rng() * 0.5 });
  }
  const rg = rocks.build();
  jitterFaces(rg, rng, 0.12);
  const rockMesh = new THREE.Mesh(ctx.disposer.track(rg), ctx.disposer.track(vcMaterial({ roughness: 0.95, flatShading: true })));
  setShadow(rockMesh, true, true);
  g.add(rockMesh);

  // lily pads + flowers + reeds
  const pads = new GeoBuilder();
  for (let i = 0; i < 20; i++) {
    const a = rng() * Math.PI * 2;
    const r = rng() * 4.4;
    const s = 0.28 + rng() * 0.22;
    const pg = new THREE.CircleGeometry(s, 10, rng() * 6.28, Math.PI * 1.85);
    pg.rotateX(-Math.PI / 2);
    pads.add(pg, rng() > 0.5 ? '#3d8a3c' : '#4a9a45', Math.cos(a) * r, 0.215, Math.sin(a) * r);
    if (rng() > 0.62) {
      for (let p = 0; p < 6; p++) {
        const pa = (p / 6) * Math.PI * 2;
        pads.add(new THREE.ConeGeometry(0.06, 0.16, 4), i % 2 ? '#f6a6c8' : '#fff0f4', Math.cos(a) * r + Math.cos(pa) * 0.07, 0.3, Math.sin(a) * r + Math.sin(pa) * 0.07, { rx: Math.sin(pa) * 0.6, rz: -Math.cos(pa) * 0.6 });
      }
      pads.sphere(0.04, 5, 4, Math.cos(a) * r, 0.28, Math.sin(a) * r, '#ffd54a');
    }
  }
  const padMesh = new THREE.Mesh(ctx.disposer.track(pads.build()), ctx.disposer.track(vcMaterial({ roughness: 0.8, side: THREE.DoubleSide })));
  padMesh.receiveShadow = true;
  g.add(padMesh);

  const reeds = new GeoBuilder();
  for (let c = 0; c < 9; c++) {
    const a = rng() * Math.PI * 2;
    const r = 5.55 + rng() * 0.5;
    for (let k = 0; k < 7; k++) {
      const h = 0.9 + rng() * 0.9;
      const ox = (rng() - 0.5) * 0.7;
      const oz = (rng() - 0.5) * 0.7;
      const bx = Math.cos(a) * r + ox;
      const bz = Math.sin(a) * r + oz;
      reeds.cylB(0.012, 0.02, h, 4, bx, 0.15, bz, '#5e8f3a', { rx: (rng() - 0.5) * 0.25, rz: (rng() - 0.5) * 0.25 });
      if (rng() > 0.4) reeds.cylB(0.035, 0.035, 0.2, 5, bx, 0.15 + h - 0.15, bz, '#5a3a22');
    }
  }
  const reedMesh = new THREE.Mesh(ctx.disposer.track(reeds.build()), ctx.disposer.track(vcMaterial({ roughness: 0.9 })));
  g.add(reedMesh);

  // fireflies at night
  const flies = createParticles({
    count: 26,
    map: ctx.tex.softCircle,
    color: '#d6ff7a',
    additive: true,
    motion: `
      float a = seed.x * 6.28 + t * (0.15 + seed.y * 0.3);
      float r = 1.5 + seed.z * 5.4;
      center = vec3(cos(a) * r, 0.7 + seed.y * 1.6 + sin(t * 1.3 + seed.x * 20.0) * 0.25, sin(a) * r);
      size = 0.13;
      alpha = (0.5 + 0.5 * sin(t * (1.5 + seed.w * 2.0) + seed.x * 40.0));
    `,
  });
  g.add(flies.mesh);

  ctx.updaters.push((_dt, time, env) => {
    wn.offset.set(time * 0.006, time * 0.01);
    wmat.emissiveIntensity = 0.2 + env.night * 0.8;
    flies.update(time, env.night * env.night);
    flies.mesh.visible = env.night > 0.05;
  });
  root.add(g);
}

// ----------------------------------------------------------------- gazebo
function buildGazebo(ctx: WorldCtx, root: THREE.Group): void {
  const g = new THREE.Group();
  g.position.set(GAZEBO.x, 0, GAZEBO.z);
  const b = new GeoBuilder();
  const WHITE = '#efe9da';
  const WOODL = '#a98055';
  const pw = GAZEBO_PLATFORM.maxX - GAZEBO_PLATFORM.minX;
  // platform + steps on the west side
  b.boxB(pw, GAZEBO_H, pw, 0, 0, 0, '#8a6a46');
  b.boxB(pw + 0.2, 0.05, pw + 0.2, 0, 0, 0, '#6e5436');
  b.boxB(0.5, GAZEBO_H * 0.6, 2.2, -pw / 2 - 0.25, 0, 0, '#8a6a46');
  // posts, bases and capitals
  const h = GAZEBO.half;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.boxB(0.34, 0.25, 0.34, sx * h, GAZEBO_H, sz * h, '#d9d2c0');
    b.boxB(0.2, 2.75, 0.2, sx * h, GAZEBO_H + 0.25, sz * h, WHITE);
    b.boxB(0.34, 0.16, 0.34, sx * h, GAZEBO_H + 3.0, sz * h, '#d9d2c0');
  }
  // beams (with a gap on the entrance side kept clear: top beams only)
  const top = GAZEBO_H + 3.0;
  for (const sz of [-1, 1]) b.boxB(2 * h + 0.34, 0.26, 0.2, 0, top + 0.16, sz * h, WHITE);
  for (const sx of [-1, 1]) b.boxB(0.2, 0.26, 2 * h + 0.34, sx * h, top + 0.16, 0, WHITE);
  // decorative brackets
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.box(0.08, 0.7, 0.08, sx * (h - 0.28), top - 0.18, sz * h, WOODL, { rz: sx * 0.75 });
    b.box(0.08, 0.7, 0.08, sx * h, top - 0.18, sz * (h - 0.28), WOODL, { rx: -sz * 0.75 });
  }
  // low planter boxes with flowers on three sides (outside the walk lines)
  const gm = new THREE.Mesh(ctx.disposer.track(b.build()), ctx.disposer.track(vcMaterial({ roughness: 0.75 })));
  setShadow(gm, true, true);
  g.add(gm);
  // roof (octagonal pyramid with tile texture)
  const roofTex = ctx.rep(ctx.tex.roofTile, 4, 2);
  const roofMat = ctx.disposer.track(new THREE.MeshStandardMaterial({ map: roofTex, color: '#8a3b2b', roughness: 0.75, side: THREE.DoubleSide }));
  const roof = new THREE.Mesh(ctx.disposer.track(new THREE.ConeGeometry(3.6, 1.7, 8, 1, true)), roofMat);
  roof.rotation.y = Math.PI / 8;
  roof.position.y = top + 0.3 + 0.85;
  setShadow(roof, true, true);
  g.add(roof);
  const fin = new GeoBuilder();
  fin.cylB(0.03, 0.12, 0.5, 8, 0, 0, 0, '#c8a24a');
  fin.sphere(0.12, 8, 6, 0, 0.55, 0, '#c8a24a');
  const finMesh = new THREE.Mesh(ctx.disposer.track(fin.build()), ctx.disposer.track(vcMaterial({ metalness: 0.6, roughness: 0.4 })));
  finMesh.position.y = top + 0.3 + 1.7;
  g.add(finMesh);
  // hanging lantern with emissive bulb
  const lantern = new THREE.Mesh(ctx.disposer.track(new THREE.SphereGeometry(0.16, 10, 8)), ctx.disposer.track(new THREE.MeshBasicMaterial({ color: '#ffd9a0', toneMapped: false })));
  lantern.position.set(0, top - 0.5, 0);
  g.add(lantern);
  const chain = new THREE.Mesh(ctx.disposer.track(new THREE.CylinderGeometry(0.012, 0.012, 0.6, 4)), ctx.disposer.track(new THREE.MeshBasicMaterial({ color: '#222' })));
  chain.position.set(0, top - 0.15, 0);
  g.add(chain);
  const lm = lantern.material as THREE.MeshBasicMaterial;
  ctx.updaters.push((_dt, _t, env) => {
    const k = 0.5 + env.lampOn * 1.4;
    lm.color.setRGB(1 * k, 0.82 * k, 0.55 * k);
  });
  root.add(g);
}

// -------------------------------------------------------------- playground
function buildPlayground(ctx: WorldCtx, root: THREE.Group): void {
  const swing = PROPS.find((p) => p.kind === 'swing');
  const slide = PROPS.find((p) => p.kind === 'slide');
  const sandbox = PROPS.find((p) => p.kind === 'sandbox');
  const RED = '#d9483b';
  const BLUE = '#3b78c9';
  const YEL = '#f2c230';
  const IRON = '#59606b';

  if (swing) {
    const g = new THREE.Group();
    g.position.set(swing.x, 0, swing.z);
    const f = new GeoBuilder();
    const beamY = 2.55;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) f.cylB(0.05, 0.05, 2.75, 6, sx * 1.95, 0, sz * 0.45, RED, { rx: sz * -0.17 });
      f.cylB(0.07, 0.07, 1.0, 6, sx * 1.95, beamY - 0.05, 0, RED, { rx: Math.PI / 2 });
    }
    f.cylB(0.07, 0.07, 4.0, 8, 0, beamY, 0, RED, { rz: Math.PI / 2 });
    const frame = new THREE.Mesh(ctx.disposer.track(f.build()), ctx.disposer.track(vcMaterial({ roughness: 0.5, metalness: 0.2 })));
    setShadow(frame, true, true);
    g.add(frame);
    const seatGeo = (() => {
      const s = new GeoBuilder();
      s.box(0.5, 0.05, 0.22, 0, -2.0, 0, '#2c3038');
      s.box(0.01, 2.0, 0.01, -0.22, -1.0, 0, IRON);
      s.box(0.01, 2.0, 0.01, 0.22, -1.0, 0, IRON);
      return ctx.disposer.track(s.build());
    })();
    const seatMat = ctx.disposer.track(vcMaterial({ roughness: 0.6, metalness: 0.2 }));
    const swings: THREE.Mesh[] = [];
    for (const sx of [-0.75, 0.75]) {
      const piv = new THREE.Group();
      piv.position.set(sx, beamY, 0);
      const m = new THREE.Mesh(seatGeo, seatMat);
      m.castShadow = true;
      piv.add(m);
      g.add(piv);
      swings.push(piv as unknown as THREE.Mesh);
    }
    ctx.updaters.push((_dt, time) => {
      swings[0].rotation.x = Math.sin(time * 1.25) * 0.32;
      swings[1].rotation.x = Math.sin(time * 1.25 + 1.6) * 0.22;
    });
    root.add(g);
  }

  if (slide) {
    const g = new THREE.Group();
    g.position.set(slide.x, 0, slide.z);
    const s = new GeoBuilder();
    // tower at -z end
    const tz = -1.15;
    const th = 1.65;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) s.cylB(0.05, 0.05, th + 0.9, 6, sx * 0.55, 0, tz + sz * 0.45, BLUE);
    s.boxB(1.2, 0.08, 1.0, 0, th, tz, '#b98b50');
    // roof
    s.boxB(1.4, 0.07, 1.2, 0, th + 0.9, tz, YEL);
    // rails
    for (const sx of [-1, 1]) s.boxB(0.04, 0.55, 1.0, sx * 0.58, th, tz, BLUE);
    s.boxB(1.2, 0.55, 0.04, 0, th, tz - 0.48, BLUE);
    // ladder at back
    for (let i = 0; i < 6; i++) s.box(0.7, 0.05, 0.05, 0, 0.25 + i * 0.27, tz - 0.62 - i * 0.04, '#d9d9d9');
    for (const sx of [-1, 1]) s.box(0.05, 1.8, 0.05, sx * 0.35, 0.9, tz - 0.7, '#d9d9d9', { rx: -0.14 });
    // chute (tilted board from tower front to ground)
    const len = Math.hypot(2.55, th - 0.15);
    const ang = Math.atan2(th - 0.15, 2.55);
    s.box(0.7, 0.05, len, 0, (th + 0.15) / 2, tz + 0.5 + 2.55 / 2, RED, { rx: ang });
    for (const sx of [-1, 1]) s.box(0.05, 0.16, len, sx * 0.37, (th + 0.15) / 2 + 0.07, tz + 0.5 + 2.55 / 2, YEL, { rx: ang });
    const mesh = new THREE.Mesh(ctx.disposer.track(s.build()), ctx.disposer.track(vcMaterial({ roughness: 0.5, metalness: 0.15 })));
    setShadow(mesh, true, true);
    g.add(mesh);
    root.add(g);
  }

  if (sandbox) {
    const g = new THREE.Group();
    g.position.set(sandbox.x, 0, sandbox.z);
    const b = new GeoBuilder();
    const W = 3.2;
    b.boxB(W, 0.16, 0.16, 0, 0, -W / 2, '#9a6a3c');
    b.boxB(W, 0.16, 0.16, 0, 0, W / 2, '#9a6a3c');
    b.boxB(0.16, 0.16, W, -W / 2, 0, 0, '#9a6a3c');
    b.boxB(0.16, 0.16, W, W / 2, 0, 0, '#9a6a3c');
    const frame = new THREE.Mesh(ctx.disposer.track(b.build()), ctx.disposer.track(vcMaterial({ roughness: 0.9 })));
    setShadow(frame, true, true);
    g.add(frame);
    const sandMat = ctx.disposer.track(new THREE.MeshStandardMaterial({ map: ctx.rep(ctx.tex.sand, 2, 2), roughness: 1 }));
    const sand = new THREE.Mesh(ctx.disposer.track(new THREE.BoxGeometry(W - 0.1, 0.12, W - 0.1)), sandMat);
    sand.position.y = 0.07;
    sand.receiveShadow = true;
    g.add(sand);
    const t = new GeoBuilder();
    t.cylB(0.18, 0.14, 0.2, 8, -0.7, 0.13, 0.5, '#e85b4a');
    t.cylB(0.12, 0.2, 0.18, 8, 0.3, 0.13, -0.4, '#e2c27a');
    t.cylB(0.0, 0.1, 0.14, 8, 0.3, 0.31, -0.4, '#e2c27a');
    t.box(0.05, 0.03, 0.3, 0.8, 0.14, 0.7, '#3b78c9', { ry: 0.6 });
    const toys = new THREE.Mesh(ctx.disposer.track(t.build()), ctx.disposer.track(vcMaterial()));
    toys.castShadow = true;
    g.add(toys);
    root.add(g);
  }
  void PLAYGROUND;
}

// -------------------------------------------------------------------- cars
const CARS: { x: number; z: number; rot: number; color: string }[] = [
  { x: -50, z: -3.9, rot: Math.PI, color: '#c0392b' },
  { x: -27, z: 3.9, rot: 0, color: '#2c6fb7' },
  { x: -13.5, z: 3.9, rot: 0, color: '#e6e6e6' },
  { x: 14, z: -3.9, rot: Math.PI, color: '#f0b429' },
  { x: 32, z: 3.9, rot: 0, color: '#2f9e6b' },
  { x: 50, z: -3.9, rot: Math.PI, color: '#7a4aa3' },
];
function carGeometry(color: string): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const GLASS = '#1d2b38';
  const DARK = '#1b1c20';
  // wheels
  for (const sx of [-1.35, 1.3]) for (const sz of [-0.86, 0.86]) {
    b.add(new THREE.CylinderGeometry(0.34, 0.34, 0.26, 14), DARK, sx, 0.34, sz, { rx: Math.PI / 2 });
    b.add(new THREE.CylinderGeometry(0.2, 0.2, 0.28, 10), '#bfc3c9', sx, 0.34, sz, { rx: Math.PI / 2 });
  }
  b.box(4.2, 0.5, 1.78, 0, 0.62, 0, color);
  b.box(1.4, 0.2, 1.7, 1.35, 0.9, 0, color, { rz: -0.1 }); // hood
  b.box(1.1, 0.2, 1.7, -1.55, 0.9, 0, color, { rz: 0.08 }); // trunk
  b.box(2.0, 0.5, 1.62, -0.1, 1.14, 0, GLASS);
  b.box(1.78, 0.07, 1.66, -0.1, 1.42, 0, color);
  for (const sz of [-0.83, 0.83]) {
    b.box(0.09, 0.5, 0.06, 0.88, 1.14, sz, color, { rz: -0.35 });
    b.box(0.09, 0.5, 0.06, -1.08, 1.14, sz, color, { rz: 0.35 });
    b.box(0.07, 0.5, 0.06, -0.1, 1.14, sz, color);
    b.box(4.22, 0.05, 0.03, 0, 0.82, sz * 1.05, '#d8d8d8');
  }
  b.box(0.14, 0.2, 1.8, 2.12, 0.42, 0, DARK);
  b.box(0.14, 0.2, 1.8, -2.12, 0.42, 0, DARK);
  for (const sz of [-0.62, 0.62]) {
    b.box(0.06, 0.12, 0.3, 2.1, 0.7, sz, '#fff4c8');
    b.box(0.06, 0.12, 0.3, -2.1, 0.7, sz, '#c0161d');
  }
  for (const sz of [-0.95, 0.95]) b.box(0.14, 0.08, 0.12, 0.7, 1.0, sz, color);
  return b.build();
}
function buildCars(ctx: WorldCtx, root: THREE.Group): void {
  const mat = ctx.disposer.track(vcMaterial({ roughness: 0.35, metalness: 0.35 }));
  for (const c of CARS) {
    const m = new THREE.Mesh(ctx.disposer.track(carGeometry(c.color)), mat);
    m.position.set(c.x, 0.02, c.z);
    m.rotation.y = c.rot;
    setShadow(m, true, true);
    root.add(m);
  }
}

// ------------------------------------------------------- street furniture
function buildFurniture(ctx: WorldCtx, root: THREE.Group): void {
  const b = new GeoBuilder();
  const rng = mulberry32(31337);
  // tree pits around sidewalk trees
  for (const p of PROPS) {
    if (p.kind === 'tree' && Math.abs(p.z) < 9 && Math.abs(p.z) > 5) {
      b.boxB(1.5, 0.03, 1.5, p.x, SIDEWALK_H, p.z, '#5a4632');
      for (const s of [-1, 1]) {
        b.boxB(1.6, 0.07, 0.08, p.x, SIDEWALK_H, p.z + s * 0.76, '#7a7870');
        b.boxB(0.08, 0.07, 1.5, p.x + s * 0.76, SIDEWALK_H, p.z, '#7a7870');
      }
    }
  }
  // bins & hydrants by lamps (every other lamp)
  const lamps = PROPS.filter((p) => p.kind === 'lamp');
  lamps.forEach((l, i) => {
    if (i % 4 === 1) {
      const dir = l.z < 0 ? -1 : 1;
      const bx = l.x + 1.2;
      const bz = l.z + dir * 0.9;
      b.cylB(0.26, 0.23, 0.78, 10, bx, SIDEWALK_H, bz, '#3f5f4a');
      b.cylB(0.28, 0.28, 0.06, 10, bx, SIDEWALK_H + 0.78, bz, '#2c3038');
    }
    if (i % 6 === 4) {
      const hx = l.x - 1.4;
      const hz = l.z + (l.z < 0 ? -0.5 : 0.5);
      b.cylB(0.11, 0.13, 0.6, 8, hx, SIDEWALK_H, hz, '#d23a2e');
      b.sphere(0.12, 8, 6, hx, SIDEWALK_H + 0.62, hz, '#d23a2e');
      b.box(0.34, 0.09, 0.09, hx, SIDEWALK_H + 0.4, hz, '#d23a2e');
    }
  });
  // mailbox & bike rack by the post office / cafe
  const post = BUILDINGS.find((x) => x.kind === 'post');
  if (post) {
    const mx = post.x + post.w / 2 - 1.2;
    const mz = post.z - post.d / 2 - 0.7;
    b.boxB(0.1, 0.9, 0.1, mx, SIDEWALK_H, mz, '#2c3038');
    b.boxB(0.55, 0.5, 0.42, mx, SIDEWALK_H + 0.9, mz, '#2f5db0');
    b.cylB(0.21, 0.21, 0.55, 12, mx, SIDEWALK_H + 1.4, mz, '#2f5db0', { rz: Math.PI / 2 });
    b.box(0.3, 0.05, 0.02, mx, SIDEWALK_H + 1.25, mz - 0.22, '#111');
  }
  const cafe = BUILDINGS.find((x) => x.kind === 'cafe');
  if (cafe) {
    const rx = cafe.x + cafe.w / 2 - 1.5;
    const rz = cafe.z - cafe.d / 2 - 0.45;
    for (let i = 0; i < 4; i++) {
      b.add(new THREE.TorusGeometry(0.28, 0.025, 6, 14, Math.PI), '#7a7f88', rx + i * 0.4, SIDEWALK_H, rz);
    }
  }
  // flower planters on the plaza corners
  for (const [px, pz] of [[-9.8, 11.2], [12.8, 11.2], [-9.8, 41.6], [12.8, 41.6]] as [number, number][]) {
    b.boxB(1.5, 0.5, 1.5, px, SIDEWALK_H, pz, '#a9744a');
    b.boxB(1.3, 0.06, 1.3, px, SIDEWALK_H + 0.5, pz, '#4a3626');
    for (let k = 0; k < 14; k++) {
      const col = ['#e5566d', '#f4c542', '#f78fb3', '#ffffff', '#b97bd6', '#ff8a3d'][Math.floor(rng() * 6)];
      b.sphere(0.12, 5, 4, px + (rng() - 0.5) * 1.1, SIDEWALK_H + 0.7 + rng() * 0.2, pz + (rng() - 0.5) * 1.1, col);
    }
    b.sphere(0.4, 6, 5, px, SIDEWALK_H + 0.75, pz, '#3f8a3a', { sy: 0.7 });
  }
  const geo = ctx.disposer.track(b.build());
  const m = new THREE.Mesh(geo, ctx.disposer.track(vcMaterial({ roughness: 0.85 })));
  setShadow(m, true, true);
  root.add(m);
}

export function buildProps(ctx: WorldCtx): PropsResult {
  const root = new THREE.Group();
  root.name = 'props';
  const lamps = buildLamps(ctx, root);
  buildBenches(ctx, root);
  buildFountain(ctx, root);
  buildPond(ctx, root);
  buildGazebo(ctx, root);
  buildPlayground(ctx, root);
  buildCars(ctx, root);
  buildFurniture(ctx, root);
  return { root, lamps };
}
