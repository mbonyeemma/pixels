import { Component, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { runtime, useGame } from '../state';
import Scene from './Scene';
import { camState, skyState } from './env';

declare global {
  interface Window {
    __pixelsWebGL?: boolean;
    __pixels?: {
      getPose: () => { x: number; z: number; ry: number; anim: string; speed: number };
      remotes: () => { id: string; name: string; x: number; z: number; ry: number; anim: string }[];
      camera: () => { yaw: number; pitch: number; dist: number; eff: number; x: number; y: number; z: number };
      time: () => number;
      info: () => { calls: number; triangles: number; geometries: number; textures: number } | null;
    };
  }
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return false;
    const ext = (gl as WebGLRenderingContext).getExtension('WEBGL_lose_context');
    ext?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function Fallback({ detail }: { detail?: string }) {
  return (
    <div
      role="alert"
      style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column',
        gap: 8, textAlign: 'center', padding: 24, color: '#e8ecf4', font: '16px/1.5 system-ui, sans-serif',
        background: 'linear-gradient(180deg,#26324d,#141a2b)',
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 700 }}>3D graphics are not available</div>
      <div style={{ maxWidth: 440, opacity: 0.85 }}>
        Pixels needs WebGL to draw the town. Try enabling hardware acceleration in your browser settings, updating your graphics
        drivers, or using a recent version of Chrome, Edge, Firefox or Safari.
      </div>
      {detail ? <div style={{ fontSize: 12, opacity: 0.55 }}>{detail}</div> : null}
    </div>
  );
}

class GLBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  componentDidCatch(): void {
    window.__pixelsWebGL = false;
  }
  render() {
    return this.state.error ? <Fallback detail={this.state.error} /> : this.props.children;
  }
}

/** The 3D game layer. Fills its (positioned) parent; the DOM UI draws on top. */
export default function GameCanvas() {
  const quality = useGame((s) => s.quality);
  const ok = useMemo(() => {
    const v = webglAvailable();
    window.__pixelsWebGL = v;
    return v;
  }, []);
  const [glInfo, setGlInfo] = useState<THREE.WebGLRenderer | null>(null);

  useEffect(() => {
    window.__pixels = {
      getPose: () => ({ ...runtime.local }),
      remotes: () => [...runtime.remotes.values()].map((r) => ({ id: r.id, name: r.name, x: r.x, z: r.z, ry: r.ry, anim: r.anim })),
      camera: () => ({ yaw: camState.yaw, pitch: camState.pitch, dist: camState.dist, eff: camState.effDist, x: camState.x, y: camState.y, z: camState.z }),
      time: () => skyState.t,
      info: () => (glInfo ? { calls: glInfo.info.render.calls, triangles: glInfo.info.render.triangles, geometries: glInfo.info.memory.geometries, textures: glInfo.info.memory.textures } : null),
    };
    return () => {
      delete window.__pixels;
    };
  }, [glInfo]);

  if (!ok) return <Fallback />;
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <GLBoundary>
        <Canvas
          shadows
          dpr={quality === 'low' ? 1 : [1, 1.75]}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
          camera={{ fov: 55, near: 0.15, far: 2500, position: [1.5, 6, 24] }}
          onCreated={({ gl }) => {
            gl.toneMapping = THREE.ACESFilmicToneMapping;
            gl.shadowMap.type = THREE.PCFSoftShadowMap;
            gl.info.autoReset = true;
            setGlInfo(gl);
            gl.domElement.addEventListener('webglcontextlost', (e) => e.preventDefault());
          }}
          style={{ position: 'absolute', inset: 0 }}
        >
          <Scene />
        </Canvas>
      </GLBoundary>
    </div>
  );
}
