import { useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { runtime, useGame } from '../state';
import { camState } from './env';
import { cameraClearDistance, clamp, clampDist, clampPitch, orbitDir } from './logic/camera';
import { buildCameraBoxes } from './logic/world';
import { groundHeight } from './logic/layout';

const boxes = buildCameraBoxes();
const _d = { x: 0, y: 0, z: 0 };
const LOOK_HEIGHT = 1.62; // slightly above the shoulders
const SENS = 0.0052;

/** Third-person orbit camera: mouse/touch drag to orbit, wheel/pinch to zoom, building-aware collision. */
export default function CameraRig() {
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    const el = gl.domElement;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    const prev = el.style.cursor;
    el.style.cursor = 'grab';
    el.style.touchAction = 'none';
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button > 2) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try {
        el.setPointerCapture(e.pointerId);
      } catch { /* ignore */ }
      el.style.cursor = 'grabbing';
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    };
    const move = (e: PointerEvent) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pointers.size === 1) {
        camState.yaw -= dx * SENS;
        camState.pitch = clampPitch(camState.pitch + dy * SENS);
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0) camState.dist = clampDist(camState.dist * (pinch / Math.max(d, 1)));
        pinch = d;
      }
    };
    const end = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch { /* ignore */ }
      if (pointers.size === 0) el.style.cursor = 'grab';
      pinch = 0;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const k = e.deltaMode === 1 ? 16 : 1;
      camState.dist = clampDist(camState.dist * Math.exp(e.deltaY * k * 0.0012));
    };
    const ctx = (e: Event) => e.preventDefault();
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('contextmenu', ctx);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('contextmenu', ctx);
      el.style.cursor = prev;
    };
  }, [gl]);

  useFrame((state, delta) => {
    const cam = state.camera;
    const dt = Math.min(delta, 0.1);
    const selfId = useGame.getState().selfId;
    let tx: number;
    let tz: number;
    if (!selfId) {
      // login backdrop: slow orbit around the plaza
      camState.yaw += dt * 0.05;
      camState.pitch = 0.3;
      camState.dist = 30;
      tx = 1.5;
      tz = 6;
    } else {
      tx = runtime.local.x;
      tz = runtime.local.z;
    }
    if (!camState.ready) {
      camState.x = tx;
      camState.z = tz;
      camState.y = groundHeight(tx, tz);
      if (selfId) camState.yaw = runtime.local.ry + Math.PI;
      camState.ready = true;
    }
    // damped follow of the target (frame-rate independent)
    const k = 1 - Math.exp(-dt * 16);
    camState.x += (tx - camState.x) * k;
    camState.z += (tz - camState.z) * k;
    camState.y += (groundHeight(tx, tz) - camState.y) * k;
    camState.pitch = clampPitch(camState.pitch);
    camState.dist = selfId ? clampDist(camState.dist) : camState.dist;

    const ty = camState.y + LOOK_HEIGHT;
    orbitDir(camState.yaw, camState.pitch, _d);
    const desired = camState.dist;
    const clear = cameraClearDistance(camState.x, ty, camState.z, _d.x, _d.y, _d.z, desired, boxes);
    // shorten immediately (never clip), extend smoothly
    if (clear < camState.effDist) camState.effDist = clear;
    else camState.effDist += (clear - camState.effDist) * (1 - Math.exp(-dt * 5));
    const dist = camState.effDist;
    let cx = camState.x + _d.x * dist;
    let cy = ty + _d.y * dist;
    let cz = camState.z + _d.z * dist;
    cy = Math.max(cy, 0.35 + groundHeight(cx, cz));
    cam.position.set(cx, cy, cz);
    camState.cx = cx;
    camState.cy = cy;
    camState.cz = cz;
    cam.lookAt(camState.x, ty - 0.12, camState.z);
    runtime.cameraYaw = camState.yaw;
    void clamp;
    void THREE;
    cx = cy = cz = 0;
  }, -1);

  return null;
}
