import * as THREE from 'three';
import { createTextures, type Textures } from './gfx/textures';
import type { SkyState } from './logic/daynight';
import { makeCtx } from './world/ctx';
import { buildGround } from './world/ground';
import { buildTrees } from './world/trees';
import { buildProps } from './world/props';
import { buildBuildings } from './world/buildings';

export interface WorldHandle {
  root: THREE.Group;
  textures: Textures;
  lamps: THREE.Vector3[];
  update(dt: number, time: number, env: SkyState): void;
  setClock(t: number): void;
  dispose(): void;
}

/** Builds the whole static town (procedural geometry + canvas textures). Call once; dispose when unmounting. */
export function buildWorld(detail: 'low' | 'high'): WorldHandle {
  const textures = createTextures();
  const ctx = makeCtx(textures, detail);
  const root = new THREE.Group();
  root.name = 'town';
  root.add(buildGround(ctx));
  root.add(buildTrees(ctx));
  const props = buildProps(ctx);
  root.add(props.root);
  const buildings = buildBuildings(ctx);
  root.add(buildings.root);
  return {
    root,
    textures,
    lamps: props.lamps,
    update(dt, time, env) {
      for (const u of ctx.updaters) u(dt, time, env);
    },
    setClock: buildings.setClock,
    dispose() {
      ctx.disposer.disposeAll();
      textures.dispose();
    },
  };
}
