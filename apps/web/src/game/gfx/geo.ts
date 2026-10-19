import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface XForm {
  rx?: number;
  ry?: number;
  rz?: number;
  sx?: number;
  sy?: number;
  sz?: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

/** Collects primitives with a flat colour each and merges them into ONE vertex-coloured, non-indexed geometry. */
export class GeoBuilder {
  readonly parts: THREE.BufferGeometry[] = [];

  add(g: THREE.BufferGeometry, color: THREE.ColorRepresentation, x = 0, y = 0, z = 0, t: XForm = {}): this {
    const geo = g.index ? g.toNonIndexed() : g.clone();
    if (g !== geo) g.dispose();
    _e.set(t.rx ?? 0, t.ry ?? 0, t.rz ?? 0, 'YXZ');
    _q.setFromEuler(_e);
    _p.set(x, y, z);
    _s.set(t.sx ?? 1, t.sy ?? 1, t.sz ?? 1);
    _m.compose(_p, _q, _s);
    geo.applyMatrix4(_m);
    for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') geo.deleteAttribute(k);
    _c.set(color);
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = _c.r;
      col[i * 3 + 1] = _c.g;
      col[i * 3 + 2] = _c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.parts.push(geo);
    return this;
  }

  /** Axis aligned box centred at (x,y,z). */
  box(w: number, h: number, d: number, x: number, y: number, z: number, color: THREE.ColorRepresentation, t: XForm = {}): this {
    return this.add(new THREE.BoxGeometry(w, h, d), color, x, y, z, t);
  }
  /** Box whose BOTTOM face is at y. */
  boxB(w: number, h: number, d: number, x: number, y: number, z: number, color: THREE.ColorRepresentation, t: XForm = {}): this {
    return this.box(w, h, d, x, y + h / 2, z, color, t);
  }
  cyl(rTop: number, rBot: number, h: number, seg: number, x: number, y: number, z: number, color: THREE.ColorRepresentation, t: XForm = {}): this {
    return this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg), color, x, y, z, t);
  }
  cylB(rTop: number, rBot: number, h: number, seg: number, x: number, y: number, z: number, color: THREE.ColorRepresentation, t: XForm = {}): this {
    return this.cyl(rTop, rBot, h, seg, x, y + h / 2, z, color, t);
  }
  sphere(r: number, ws: number, hs: number, x: number, y: number, z: number, color: THREE.ColorRepresentation, t: XForm = {}): this {
    return this.add(new THREE.SphereGeometry(r, ws, hs), color, x, y, z, t);
  }

  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Resource tracker so everything created while building the world can be disposed in one call. */
export class Disposer {
  private items: { dispose(): void }[] = [];
  track<T extends { dispose(): void }>(o: T): T {
    this.items.push(o);
    return o;
  }
  disposeAll(): void {
    for (const i of this.items) i.dispose();
    this.items.length = 0;
  }
}

export function setShadow<T extends THREE.Object3D>(o: T, cast: boolean, receive: boolean): T {
  o.castShadow = cast;
  o.receiveShadow = receive;
  return o;
}

/** Freeze the transform of a static subtree (saves matrix updates every frame). */
export function freeze(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    o.matrixAutoUpdate = false;
    o.matrixWorldAutoUpdate = false;
  });
}

/**
 * Tint per-face (flat shaded, non-indexed) by a function of the face centre. Used for low-poly foliage so each facet
 * gets slightly different brightness.
 */
export function jitterFaces(g: THREE.BufferGeometry, rng: () => number, amount: number): void {
  const col = g.getAttribute('color') as THREE.BufferAttribute;
  for (let i = 0; i + 2 < col.count; i += 3) {
    const k = 1 + (rng() - 0.5) * 2 * amount;
    for (let j = 0; j < 3; j++) col.setXYZ(i + j, Math.min(1, col.getX(i + j) * k), Math.min(1, col.getY(i + j) * k), Math.min(1, col.getZ(i + j) * k));
  }
  col.needsUpdate = true;
}

/** Flat-shade a non-indexed geometry (recompute face normals). */
export function flatNormals(g: THREE.BufferGeometry): void {
  g.computeVertexNormals();
}

/** Multiply colours by a vertical gradient: bottom factor -> top factor between y0..y1. */
export function verticalShade(g: THREE.BufferGeometry, y0: number, y1: number, bottom: number, top: number): void {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const col = g.getAttribute('color') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const u = Math.min(1, Math.max(0, (pos.getY(i) - y0) / (y1 - y0)));
    const k = bottom + (top - bottom) * u;
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
  col.needsUpdate = true;
}

/** Shared vertex-colour standard material factory. */
export function vcMaterial(opts: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, ...opts });
}
