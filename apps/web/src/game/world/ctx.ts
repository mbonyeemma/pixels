import * as THREE from 'three';
import { Disposer } from '../gfx/geo';
import type { Textures } from '../gfx/textures';
import type { SkyState } from '../logic/daynight';

export type Updater = (dt: number, time: number, env: SkyState) => void;

/** Shared construction context for the static world builders. */
export interface WorldCtx {
  tex: Textures;
  disposer: Disposer;
  updaters: Updater[];
  /** high = full detail; low = fewer instances */
  detail: 'low' | 'high';
  /** clone a texture with its own repeat (shares the image) */
  rep(t: THREE.Texture, rx: number, ry: number): THREE.Texture;
}

export function makeCtx(tex: Textures, detail: 'low' | 'high'): WorldCtx {
  const disposer = new Disposer();
  return {
    tex,
    disposer,
    updaters: [],
    detail,
    rep(t, rx, ry) {
      const c = t.clone();
      c.wrapS = c.wrapT = THREE.RepeatWrapping;
      c.repeat.set(rx, ry);
      c.needsUpdate = true;
      return disposer.track(c);
    },
  };
}

/** A flat quad (+y normal) over a rectangle with world-aligned UVs (1 uv unit = `tile` metres). */
export function rectGeometry(minX: number, maxX: number, minZ: number, maxZ: number, y: number, tile: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const p = [minX, y, minZ, minX, y, maxZ, maxX, y, maxZ, minX, y, minZ, maxX, y, maxZ, maxX, y, minZ];
  const uv: number[] = [];
  for (let i = 0; i < 18; i += 3) uv.push(p[i] / tile, p[i + 2] / tile);
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}
