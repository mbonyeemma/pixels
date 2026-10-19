import { memo, useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { itemById } from '@pixels/shared';
import type { Anim, Equipped } from '../types';
import { avatarPalette, type AvatarPalette } from './logic/palette';
import { gaitFor, makePose, POSE_KEYS, targetPose, type JointPose } from './logic/animPose';
import { groundHeight } from './logic/layout';
import { acquireNameTexture, drawBubble, releaseNameTexture } from './gfx/tags';

/** Mutable state a controller writes every frame; the Avatar reads it in its own useFrame. */
export interface AvatarDriver {
  x: number;
  z: number;
  ry: number;
  anim: Anim;
  /** ground speed in m/s (drives gait cadence and amplitude) */
  speed: number;
}
export const makeDriver = (): AvatarDriver => ({ x: 0, z: 0, ry: 0, anim: 'idle', speed: 0 });

export interface AvatarExtras {
  apron?: string;
}

// ---------------------------------------------------------------- the rig
const B = { hips: 0, spine: 1, head: 2, armL: 3, foreL: 4, armR: 5, foreR: 6, legL: 7, shinL: 8, legR: 9, shinR: 10 } as const;
const JOINTS: { name: keyof typeof B; parent: keyof typeof B | null; pos: [number, number, number] }[] = [
  { name: 'hips', parent: null, pos: [0, 0.92, 0] },
  { name: 'spine', parent: 'hips', pos: [0, 0.98, 0] },
  { name: 'head', parent: 'spine', pos: [0, 1.5, 0] },
  { name: 'armL', parent: 'spine', pos: [0.235, 1.43, 0] },
  { name: 'foreL', parent: 'armL', pos: [0.235, 1.15, 0] },
  { name: 'armR', parent: 'spine', pos: [-0.235, 1.43, 0] },
  { name: 'foreR', parent: 'armR', pos: [-0.235, 1.15, 0] },
  { name: 'legL', parent: 'hips', pos: [0.1, 0.92, 0] },
  { name: 'shinL', parent: 'legL', pos: [0.1, 0.48, 0] },
  { name: 'legR', parent: 'hips', pos: [-0.1, 0.92, 0] },
  { name: 'shinR', parent: 'legR', pos: [-0.1, 0.48, 0] },
];

class SkinBuilder {
  parts: THREE.BufferGeometry[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private c = new THREE.Color();
  add(g: THREE.BufferGeometry, bone: number, color: string, x: number, y: number, z: number, o: { rx?: number; ry?: number; rz?: number; sx?: number; sy?: number; sz?: number } = {}): void {
    const geo = g.index ? g.toNonIndexed() : g.clone();
    g.dispose();
    this.e.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0);
    this.q.setFromEuler(this.e);
    this.m.compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1));
    geo.applyMatrix4(this.m);
    for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal') geo.deleteAttribute(k);
    const n = geo.attributes.position.count;
    this.c.set(color);
    const col = new Float32Array(n * 3);
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      col[i * 3] = this.c.r;
      col[i * 3 + 1] = this.c.g;
      col[i * 3 + 2] = this.c.b;
      si[i * 4] = bone;
      sw[i * 4] = 1;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    this.parts.push(geo);
  }
  rbox(bone: number, color: string, w: number, h: number, d: number, x: number, y: number, z: number, r = 0.02, o = {}): void {
    const rr = Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001);
    // tiny detail parts use a plain box; larger parts a 2-segment rounded box
    if (Math.min(w, h, d) < 0.05 || r < 0.015) this.add(new THREE.BoxGeometry(w, h, d), bone, color, x, y, z, o);
    else this.add(new RoundedBoxGeometry(w, h, d, r > 0.04 ? 2 : 1, rr), bone, color, x, y, z, o);
  }
  capsule(bone: number, color: string, radius: number, total: number, x: number, y: number, z: number, o = {}): void {
    this.add(new THREE.CapsuleGeometry(radius, Math.max(0.001, total - radius * 2), 2, 7), bone, color, x, y, z, o);
  }
  sphere(bone: number, color: string, r: number, x: number, y: number, z: number, o = {}): void {
    this.add(new THREE.SphereGeometry(r, 8, 6), bone, color, x, y, z, o);
  }
  box(bone: number, color: string, w: number, h: number, d: number, x: number, y: number, z: number, o = {}): void {
    this.add(new THREE.BoxGeometry(w, h, d), bone, color, x, y, z, o);
  }
  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    g.computeBoundingSphere();
    return g;
  }
}

const darker = (hex: string, k: number): string => '#' + new THREE.Color(hex).multiplyScalar(k).getHexString();

export interface RigOptions {
  palette: AvatarPalette;
  equipped: Equipped;
  extras?: AvatarExtras;
}

function buildGeometry({ palette: p, equipped, extras }: RigOptions): { geo: THREE.BufferGeometry; glow: string | null } {
  const sb = new SkinBuilder();
  const hat = equipped.hat ? itemById(equipped.hat) : undefined;
  const face = equipped.face ? itemById(equipped.face) : undefined;
  const shoes = equipped.shoes ? itemById(equipped.shoes) : undefined;
  const jacket = equipped.jacket ? itemById(equipped.jacket) : undefined;
  const shirt = jacket ? jacket.color ?? '#ff7043' : p.shirt;
  const shoeCol = shoes ? shoes.color ?? '#00e5ff' : p.shoes;
  const bw = p.build;
  const skinD = darker(p.skin, 0.82);

  // torso
  sb.rbox(B.hips, p.pants, 0.34 * bw, 0.2, 0.2, 0, 0.98, 0, 0.05);
  sb.rbox(B.spine, shirt, 0.36 * bw, 0.5, 0.21, 0, 1.2, 0, 0.07);
  sb.rbox(B.spine, shirt, 0.43 * bw, 0.17, 0.215, 0, 1.38, 0, 0.07);
  sb.rbox(B.spine, darker(p.pants, 0.7), 0.35 * bw, 0.035, 0.215, 0, 1.015, 0, 0.012); // belt
  if (jacket) {
    sb.rbox(B.spine, shirt, 0.41 * bw, 0.58, 0.255, 0, 1.2, -0.005, 0.09);
    sb.rbox(B.spine, darker(shirt, 0.82), 0.26, 0.19, 0.12, 0, 1.17, 0.13, 0.04); // hoodie pocket
    sb.rbox(B.spine, darker(shirt, 0.88), 0.2, 0.11, 0.2, 0, 1.51, -0.03, 0.05); // hood ring
    sb.box(B.spine, '#e9e9e9', 0.012, 0.18, 0.012, -0.04, 1.34, 0.13);
    sb.box(B.spine, '#e9e9e9', 0.012, 0.18, 0.012, 0.04, 1.34, 0.13);
  } else {
    sb.rbox(B.spine, darker(shirt, 0.9), 0.1, 0.045, 0.1, 0, 1.46, 0.03, 0.02); // collar
  }
  if (extras?.apron) {
    sb.rbox(B.spine, extras.apron, 0.3, 0.56, 0.03, 0, 1.16, 0.12, 0.012);
    sb.rbox(B.spine, extras.apron, 0.34, 0.03, 0.22, 0, 1.0, 0, 0.012);
    sb.rbox(B.spine, darker(extras.apron, 0.85), 0.2, 0.12, 0.034, 0, 1.12, 0.14, 0.01);
  }

  // neck + head
  sb.capsule(B.head, skinD, 0.045, 0.14, 0, 1.52, 0.0);
  sb.rbox(B.head, p.skin, 0.205, 0.245, 0.225, 0, 1.64, 0.005, 0.07);
  sb.rbox(B.head, p.skin, 0.018, 0.05, 0.03, -0.108, 1.635, 0, 0.007);
  sb.rbox(B.head, p.skin, 0.018, 0.05, 0.03, 0.108, 1.635, 0, 0.007);
  sb.rbox(B.head, skinD, 0.032, 0.045, 0.035, 0, 1.625, 0.123, 0.012); // nose
  // eyes, brows, mouth
  for (const sx of [-1, 1]) {
    sb.rbox(B.head, '#f4f4f4', 0.04, 0.028, 0.012, sx * 0.05, 1.665, 0.117, 0.005);
    sb.rbox(B.head, '#1d2330', 0.02, 0.026, 0.012, sx * 0.05, 1.665, 0.121, 0.005);
    sb.rbox(B.head, darker(p.hair, 0.8), 0.05, 0.011, 0.012, sx * 0.05, 1.7, 0.117, 0.004);
  }
  sb.rbox(B.head, '#9a4d4d', 0.055, 0.012, 0.012, 0, 1.58, 0.116, 0.004);

  // hair
  const hairCol = p.hair;
  const hy = 1.64;
  if (!hat) {
    sb.rbox(B.head, hairCol, 0.218, 0.07, 0.24, 0, hy + 0.115, 0, 0.04);
  } else {
    sb.rbox(B.head, hairCol, 0.218, 0.05, 0.24, 0, hy + 0.1, -0.002, 0.03);
  }
  switch (p.hairStyle) {
    case 'long':
      sb.rbox(B.head, hairCol, 0.225, 0.4, 0.07, 0, hy - 0.1, -0.1, 0.03);
      for (const sx of [-1, 1]) sb.rbox(B.head, hairCol, 0.04, 0.3, 0.2, sx * 0.108, hy - 0.04, -0.02, 0.02);
      break;
    case 'spiky':
      for (let i = 0; i < (hat ? 0 : 6); i++) {
        const a = (i / 6) * Math.PI * 2;
        sb.add(new THREE.ConeGeometry(0.04, 0.11, 5), B.head, hairCol, Math.cos(a) * 0.06, hy + 0.17, Math.sin(a) * 0.07, { rz: -Math.cos(a) * 0.35, rx: Math.sin(a) * 0.35 });
      }
      sb.rbox(B.head, hairCol, 0.22, 0.14, 0.07, 0, hy + 0.02, -0.1, 0.03);
      break;
    case 'bun':
      sb.sphere(B.head, hairCol, 0.07, 0, hy + 0.2, -0.07);
      sb.rbox(B.head, hairCol, 0.22, 0.2, 0.07, 0, hy + 0.0, -0.1, 0.03);
      break;
    case 'side':
      sb.rbox(B.head, hairCol, 0.12, 0.05, 0.1, -0.05, hy + 0.1, 0.1, 0.02, { rz: 0.2 });
      sb.rbox(B.head, hairCol, 0.22, 0.16, 0.07, 0, hy + 0.0, -0.1, 0.03);
      break;
    case 'buzz':
      break;
    default:
      sb.rbox(B.head, hairCol, 0.22, 0.16, 0.07, 0, hy + 0.02, -0.1, 0.03);
      sb.rbox(B.head, hairCol, 0.04, 0.1, 0.2, -0.108, hy + 0.06, -0.01, 0.015);
      sb.rbox(B.head, hairCol, 0.04, 0.1, 0.2, 0.108, hy + 0.06, -0.01, 0.015);
  }

  // cosmetics
  if (hat) {
    const col = hat.color ?? '#c0392b';
    sb.add(new THREE.SphereGeometry(0.128, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), B.head, col, 0, hy + 0.1, 0.0, { sy: 0.95, sz: 1.06 });
    sb.rbox(B.head, darker(col, 0.78), 0.2, 0.022, 0.13, 0, hy + 0.105, 0.17, 0.011, { rx: 0.1 });
    sb.sphere(B.head, darker(col, 0.7), 0.018, 0, hy + 0.222, 0);
  }
  if (face) {
    const col = face.color ?? '#111111';
    for (const sx of [-1, 1]) {
      sb.rbox(B.head, col, 0.078, 0.052, 0.02, sx * 0.052, 1.667, 0.123, 0.012);
      sb.box(B.head, col, 0.012, 0.014, 0.2, sx * 0.108, 1.675, 0.02);
    }
    sb.box(B.head, col, 0.03, 0.012, 0.016, 0, 1.675, 0.126);
  }

  // arms (L = +x)
  for (const side of [1, -1] as const) {
    const arm = side > 0 ? B.armL : B.armR;
    const fore = side > 0 ? B.foreL : B.foreR;
    const x = side * 0.235;
    const sleeveCol = shirt;
    sb.capsule(arm, p.skin, 0.052, 0.3, x, 1.29, 0);
    sb.capsule(arm, sleeveCol, jacket ? 0.062 : 0.062, jacket ? 0.3 : 0.15, x, jacket ? 1.29 : 1.34, 0);
    sb.sphere(arm, sleeveCol, 0.058, x, 1.425, 0);
    sb.capsule(fore, jacket ? shirt : p.skin, jacket ? 0.056 : 0.046, 0.27, x, 1.02, 0);
    if (jacket) sb.rbox(fore, darker(shirt, 0.82), 0.12, 0.04, 0.12, x, 0.9, 0, 0.015); // cuff
    sb.rbox(fore, p.skin, 0.075, 0.1, 0.05, x, 0.84, 0.005, 0.025);
    sb.rbox(fore, p.skin, 0.02, 0.05, 0.03, x + side * 0.0, 0.83, 0.04, 0.008, { rx: -0.4 });
  }

  // legs
  for (const side of [1, -1] as const) {
    const leg = side > 0 ? B.legL : B.legR;
    const shin = side > 0 ? B.shinL : B.shinR;
    const x = side * 0.1;
    sb.capsule(leg, p.pants, 0.078, 0.5, x, 0.7, 0);
    sb.capsule(shin, p.pants, 0.064, 0.5, x, 0.26, 0);
    sb.rbox(shin, shoeCol, 0.118, 0.085, 0.27, x, 0.05, 0.045, 0.035);
    sb.rbox(shin, shoes ? darker(shoeCol, 0.6) : '#f0f0f0', 0.122, 0.022, 0.275, x, 0.013, 0.045, 0.01);
    sb.rbox(shin, darker(shoeCol, 0.8), 0.1, 0.05, 0.1, x, 0.1, -0.03, 0.02);
  }
  return { geo: sb.build(), glow: shoes ? shoes.color ?? '#00e5ff' : null };
}

const sharedMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.0 });

export interface Rig {
  group: THREE.Group;
  mesh: THREE.SkinnedMesh;
  bones: THREE.Bone[];
  glowMats: THREE.MeshBasicMaterial[];
  dispose(): void;
}

export function buildRig(opts: RigOptions): Rig {
  const { geo, glow } = buildGeometry(opts);
  const bones: THREE.Bone[] = [];
  const abs: THREE.Vector3[] = [];
  for (const j of JOINTS) {
    const b = new THREE.Bone();
    b.name = j.name;
    abs.push(new THREE.Vector3(...j.pos));
    const parent = j.parent ? bones[B[j.parent]] : null;
    const pAbs = j.parent ? abs[B[j.parent]] : new THREE.Vector3();
    b.position.set(j.pos[0] - pAbs.x, j.pos[1] - pAbs.y, j.pos[2] - pAbs.z);
    if (parent) parent.add(b);
    bones.push(b);
  }
  const mesh = new THREE.SkinnedMesh(geo, sharedMat);
  mesh.add(bones[0]);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  const group = new THREE.Group();
  group.add(mesh);
  const glowMats: THREE.MeshBasicMaterial[] = [];
  const extraGeos: THREE.BufferGeometry[] = [];
  if (glow) {
    const gm = new THREE.MeshBasicMaterial({ color: glow, toneMapped: false });
    glowMats.push(gm);
    for (const [side, shin] of [[1, B.shinL], [-1, B.shinR]] as const) {
      const sole = new THREE.BoxGeometry(0.125, 0.018, 0.28);
      extraGeos.push(sole);
      const m = new THREE.Mesh(sole, gm);
      m.position.set(side * 0.1 - abs[shin].x, 0.006 - abs[shin].y, 0.045);
      bones[shin].add(m);
      const strip = new THREE.BoxGeometry(0.125, 0.012, 0.012);
      extraGeos.push(strip);
      const s2 = new THREE.Mesh(strip, gm);
      s2.position.set(side * 0.1 - abs[shin].x, 0.075 - abs[shin].y, 0.178);
      bones[shin].add(s2);
    }
  }
  return {
    group,
    mesh,
    bones,
    glowMats,
    dispose() {
      geo.dispose();
      mesh.skeleton.dispose();
      for (const g of extraGeos) g.dispose();
      for (const m of glowMats) m.dispose();
    },
  };
}

// ----------------------------------------------------------- the component
export interface AvatarProps {
  id: string;
  name: string;
  equipped: Equipped;
  driver: AvatarDriver;
  /** returns the current chat bubble text or null; polled every frame (cheap string compare) */
  getBubble?: () => string | null;
  paletteOverride?: Partial<AvatarPalette>;
  extras?: AvatarExtras;
  showTag?: boolean;
}

const _v = new THREE.Vector3();
const NAME_RANGE = 35;

export const Avatar = memo(function Avatar({ id, name, equipped, driver, getBubble, paletteOverride, extras, showTag = true }: AvatarProps) {
  const eqKey = JSON.stringify([equipped.hat, equipped.face, equipped.shoes, equipped.jacket]);
  const ovKey = JSON.stringify([paletteOverride, extras]);
  const rig = useMemo(
    () => buildRig({ palette: { ...avatarPalette(id), ...paletteOverride }, equipped, extras }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, eqKey, ovKey],
  );
  useEffect(() => () => rig.dispose(), [rig]);
  const palette = useMemo(() => ({ ...avatarPalette(id), ...paletteOverride }), [id, paletteOverride]);

  const root = useRef<THREE.Group>(null);
  const tag = useRef<THREE.Sprite>(null);
  const bubble = useRef<THREE.Sprite>(null);
  const st = useRef({ phase: 0, time: Math.random() * 100, pose: makePose(), target: makePose(), speed: 0, bubbleText: '', y: 0, init: false });

  // name tag texture
  const nameTex = useMemo(() => acquireNameTexture(name), [name]);
  useEffect(() => () => releaseNameTexture(name), [name]);
  // bubble canvas
  const bubbleRes = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return { canvas, tex };
  }, []);
  useEffect(() => () => bubbleRes.tex.dispose(), [bubbleRes]);

  useFrame((state, dtRaw) => {
    const g = root.current;
    if (!g) return;
    const dt = Math.min(dtRaw, 0.1);
    const s = st.current;
    const camDist = _v.set(driver.x, 1.5, driver.z).distanceTo(state.camera.position);
    // position (follow sidewalks / platforms smoothly)
    const gy = groundHeight(driver.x, driver.z);
    if (!s.init) {
      s.y = gy;
      s.init = true;
    } else s.y += (gy - s.y) * Math.min(1, dt * 18);
    g.position.set(driver.x, s.y, driver.z);
    g.rotation.y = driver.ry;
    // animation (skip far away)
    if (camDist < 90) {
      s.time += dt;
      s.speed += (driver.speed - s.speed) * Math.min(1, dt * 10);
      const gait = gaitFor(s.speed);
      if (driver.anim === 'walk' || driver.anim === 'run') s.phase += gait.omega * dt;
      targetPose(driver.anim, s.time, s.phase, s.speed, s.target);
      const k = 1 - Math.exp(-dt * (driver.anim === 'walk' || driver.anim === 'run' ? 22 : 12));
      for (const key of POSE_KEYS) s.pose[key] += (s.target[key] - s.pose[key]) * k;
      applyPose(rig.bones, s.pose);
      rig.mesh.castShadow = camDist < 60;
    }
    // tags
    const sp = tag.current;
    if (sp) {
      const vis = showTag && camDist < NAME_RANGE;
      sp.visible = vis;
      if (vis) {
        const k = Math.min(2.3, Math.max(0.5, camDist / 9));
        sp.scale.set(0.3 * nameTex.aspect * k, 0.3 * k, 1);
        sp.position.y = 1.98 + 0.1 * k;
      }
    }
    const bs = bubble.current;
    if (bs) {
      const text = getBubble ? getBubble() : null;
      if (text !== s.bubbleText) {
        s.bubbleText = text ?? '';
        if (text) {
          drawBubble(bubbleRes.canvas, text);
          bubbleRes.tex.needsUpdate = true;
        }
      }
      const vis = !!text && camDist < 45;
      bs.visible = vis;
      if (vis) {
        const k = Math.min(2.1, Math.max(0.55, camDist / 10));
        bs.scale.set(2.4 * k, 1.2 * k, 1);
        bs.position.y = 1.98 + 0.1 + 0.3 * Math.min(2.3, Math.max(0.5, camDist / 9));
      }
    }
  });

  return (
    <group ref={root} scale={palette.height}>
      <primitive object={rig.group} />
      <sprite ref={tag} position={[0, 2.05, 0]} renderOrder={20}>
        <spriteMaterial map={nameTex.tex} transparent depthTest={false} depthWrite={false} toneMapped={false} fog={false} />
      </sprite>
      <sprite ref={bubble} position={[0, 2.5, 0]} center={[0.5, 0]} renderOrder={21} visible={false}>
        <spriteMaterial map={bubbleRes.tex} transparent depthTest={false} depthWrite={false} toneMapped={false} fog={false} />
      </sprite>
    </group>
  );
});

function applyPose(b: THREE.Bone[], p: JointPose): void {
  b[B.hips].position.y = JOINTS[0].pos[1] + p.hipsY;
  b[B.hips].rotation.set(0, p.hipsYaw, p.hipsRoll);
  b[B.spine].rotation.set(p.spineX, p.spineY, p.spineZ);
  b[B.head].rotation.set(p.headX, p.headY, p.headZ);
  b[B.armL].rotation.set(-p.armLSwing, 0, p.armLAbd);
  b[B.foreL].rotation.set(-p.armLElbow, 0, p.armLElbowZ);
  b[B.armR].rotation.set(-p.armRSwing, 0, -p.armRAbd);
  b[B.foreR].rotation.set(-p.armRElbow, 0, p.armRElbowZ);
  b[B.legL].rotation.set(-p.legLSwing, 0, p.legLAbd);
  b[B.shinL].rotation.set(p.legLKnee, 0, 0);
  b[B.legR].rotation.set(-p.legRSwing, 0, -p.legRAbd);
  b[B.shinR].rotation.set(p.legRKnee, 0, 0);
}
