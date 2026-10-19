import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { SHOPKEEPER_POS } from '@pixels/shared';
import { useGame } from '../state';
import { TexContext } from './assets';
import { Avatar, makeDriver } from './Avatar';
import { buildWorld } from './buildWorld';
import CameraRig from './CameraRig';
import Environment, { currentTimeOfDay } from './Environment';
import { skyState } from './env';
import LocalPlayer from './LocalPlayer';
import { MissionMarkers, NavMarkers } from './Markers';
import RemotePlayers from './RemotePlayers';

const SHOPKEEPER_LOOK = { shirt: '#f1ede3', pants: '#3b4048', hair: '#6d6a66', hairStyle: 'short', skin: '#e0a878' } as const;

function Shopkeeper() {
  const driver = useMemo(() => {
    const d = makeDriver();
    d.x = SHOPKEEPER_POS.x;
    d.z = SHOPKEEPER_POS.z;
    d.ry = 0; // faces +z, towards the customers at the counter
    return d;
  }, []);
  const override = useMemo(() => ({ ...SHOPKEEPER_LOOK }), []);
  const extras = useMemo(() => ({ apron: '#1f6f78' }), []);
  useFrame((state) => {
    // idles, and every ~9 s waves for 2.5 s
    const t = state.clock.elapsedTime % 9;
    driver.anim = t > 6 && t < 8.5 ? 'wave' : 'idle';
    driver.ry = 0.12 * Math.sin(state.clock.elapsedTime * 0.35);
  });
  return <Avatar id="npc-shopkeeper" name="Shopkeeper" equipped={{}} driver={driver} paletteOverride={override} extras={extras} />;
}

export default function Scene() {
  const quality = useGame((s) => s.quality);
  const detail = quality === 'high' ? 'high' : 'low';
  const world = useMemo(() => buildWorld(detail), [detail]);
  useEffect(() => () => world.dispose(), [world]);
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
  }, [gl]);

  useFrame((state, dt) => {
    world.update(Math.min(dt, 0.1), state.clock.elapsedTime, skyState);
    world.setClock(currentTimeOfDay());
  });

  return (
    <TexContext.Provider value={world.textures}>
      <Environment lamps={world.lamps} />
      <primitive object={world.root} />
      <Shopkeeper />
      <LocalPlayer />
      <RemotePlayers />
      <MissionMarkers />
      <NavMarkers />
      <CameraRig />
    </TexContext.Provider>
  );
}
