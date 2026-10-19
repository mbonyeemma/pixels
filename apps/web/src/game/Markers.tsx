import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { runtime, useGame } from '../state';
import { useTextures } from './assets';
import { nav } from './env';
import { createParticles } from './gfx/particles';
import { groundHeight } from './logic/layout';

type IconKind = 'goto' | 'pickup' | 'dropoff' | 'collect';

function Icon({ kind, color }: { kind: IconKind; color: string }) {
  const g = useRef<THREE.Group>(null);
  const t0 = useMemo(() => Math.random() * 6, []);
  useFrame((state, dt) => {
    const o = g.current;
    if (!o) return;
    const t = state.clock.elapsedTime + t0;
    o.rotation.y += dt * (kind === 'collect' ? 1.8 : 1.1);
    const base = kind === 'collect' ? 1.25 : 3.1;
    o.position.y = base + Math.sin(t * 2) * (kind === 'collect' ? 0.12 : 0.18);
  });
  if (kind === 'collect') {
    return (
      <group ref={g}>
        <mesh scale={[0.3, 0.46, 0.3]} castShadow>
          <octahedronGeometry args={[1, 0]} />
          <meshStandardMaterial color="#ffd54a" emissive="#ffb300" emissiveIntensity={1.1} metalness={0.7} roughness={0.22} flatShading toneMapped={false} />
        </mesh>
        <mesh scale={[0.5, 0.5, 0.5]}>
          <octahedronGeometry args={[1, 0]} />
          <meshBasicMaterial color="#ffe28a" transparent opacity={0.16} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
      </group>
    );
  }
  if (kind === 'goto') {
    return (
      <group ref={g}>
        <mesh rotation={[Math.PI, 0, 0]}>
          <coneGeometry args={[0.42, 0.85, 4]} />
          <meshBasicMaterial color={color} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0.7, 0]}>
          <boxGeometry args={[0.2, 0.55, 0.2]} />
          <meshBasicMaterial color={color} toneMapped={false} />
        </mesh>
      </group>
    );
  }
  return (
    <group ref={g}>
      <mesh castShadow>
        <boxGeometry args={[0.8, 0.6, 0.8]} />
        <meshStandardMaterial color="#c79a5c" roughness={0.7} emissive="#7a5320" emissiveIntensity={0.35} />
      </mesh>
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[0.84, 0.12, 0.84]} />
        <meshStandardMaterial color={kind === 'dropoff' ? '#2fc46a' : '#d9483b'} emissive={kind === 'dropoff' ? '#2fc46a' : '#d9483b'} emissiveIntensity={0.5} />
      </mesh>
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[0.12, 0.64, 0.84]} />
        <meshStandardMaterial color={kind === 'dropoff' ? '#2fc46a' : '#d9483b'} emissive={kind === 'dropoff' ? '#2fc46a' : '#d9483b'} emissiveIntensity={0.5} />
      </mesh>
      {kind === 'dropoff' && (
        <mesh position={[0, 0.95, 0]} rotation={[Math.PI, 0, 0]}>
          <coneGeometry args={[0.28, 0.5, 4]} />
          <meshBasicMaterial color="#6dff9c" toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

/** Tall translucent light column with a pulsing ground ring and (optionally) a floating icon. */
export function Beam({ x, z, color, radius = 0.55, icon }: { x: number; z: number; color: string; radius?: number; icon?: IconKind }) {
  const tex = useTextures();
  const ring = useRef<THREE.Mesh>(null);
  const ring2 = useRef<THREE.Mesh>(null);
  const col = useMemo(() => new THREE.Color(color), [color]);
  const y0 = groundHeight(x, z);
  const sparkles = useMemo(
    () =>
      createParticles({
        count: 18,
        map: tex.softCircle,
        color,
        additive: true,
        motion: `
          float a = seed.x * 6.2831 + t * (0.6 + seed.y);
          float r = 0.25 + seed.z * 0.55;
          float rise = fract(seed.w + t * (0.12 + seed.y * 0.15));
          center = vec3(cos(a) * r, 0.2 + rise * 2.6, sin(a) * r);
          size = 0.09 + 0.05 * seed.y;
          alpha = sin(rise * 3.1416);
        `,
      }),
    [tex, color],
  );
  useEffect(() => () => sparkles.dispose(), [sparkles]);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    sparkles.update(t, 1);
    if (ring.current) {
      const s = 1 + Math.sin(t * 2.4) * 0.06;
      ring.current.scale.set(s, s, s);
    }
    if (ring2.current) {
      const ph = (t * 0.5) % 1;
      ring2.current.scale.setScalar(0.6 + ph * 1.5);
      (ring2.current.material as THREE.MeshBasicMaterial).opacity = (1 - ph) * 0.7;
    }
  });
  return (
    <group position={[x, y0, z]}>
      <mesh position={[0, 24, 0]}>
        <cylinderGeometry args={[radius * 0.55, radius, 48, 24, 1, true]} />
        <meshBasicMaterial map={tex.beam} color={col} transparent depthWrite={false} blending={THREE.AdditiveBlending} side={THREE.DoubleSide} fog={false} toneMapped={false} />
      </mesh>
      <mesh ref={ring} position={[0, 0.08, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[radius * 1.9, radius * 2.35, 40]} />
        <meshBasicMaterial color={col} transparent opacity={0.85} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} fog={false} />
      </mesh>
      <mesh ref={ring2} position={[0, 0.09, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[radius * 1.8, radius * 2.0, 40]} />
        <meshBasicMaterial color={col} transparent opacity={0.6} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} fog={false} />
      </mesh>
      <mesh position={[0, 0.07, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[radius * 1.9, 32]} />
        <meshBasicMaterial map={tex.softCircle} color={col} transparent opacity={0.55} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} fog={false} />
      </mesh>
      {icon && <Icon kind={icon} color={color} />}
      <primitive object={sparkles.mesh} />
    </group>
  );
}

const MISSION_COLOR: Record<IconKind, string> = { goto: '#ffd54a', pickup: '#ffb13a', dropoff: '#4cd964', collect: '#ffd54a' };

export function MissionMarkers() {
  const mission = useGame((s) => s.mission);
  if (!mission) return null;
  const obj = mission.objectives[mission.current];
  if (!obj || obj.done) return null;
  return <Beam key={obj.id + mission.id} x={obj.x} z={obj.z} color={MISSION_COLOR[obj.kind]} icon={obj.kind} />;
}

const NAV_COLOR = '#2fd0ff';
const MAX_CHEVRONS = 140;
const SPACING = 1.7;

/** Beam at the active nav target plus a flowing chevron trail on the ground along the remaining path. */
export function NavMarkers() {
  const tex = useTextures();
  const [target, setTarget] = useState<{ x: number; z: number; key: object } | null>(null);
  const mesh = useRef<THREE.InstancedMesh>(null);
  const o = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);
  const geo = useMemo(() => {
    const g = new THREE.PlaneGeometry(0.62, 0.62);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);
  useEffect(() => () => geo.dispose(), [geo]);

  useFrame((state) => {
    const np = runtime.navPath;
    if (!np) {
      if (target) setTarget(null);
    } else {
      const end = np.points[np.points.length - 1];
      if (end && (!target || target.key !== np)) setTarget({ x: end.x, z: end.z, key: np });
    }
    const m = mesh.current;
    if (!m) return;
    if (!np || np.points.length === 0) {
      m.count = 0;
      return;
    }
    const t = state.clock.elapsedTime;
    const pts = np.points;
    let cx = runtime.local.x;
    let cz = runtime.local.z;
    let n = 0;
    let carry = SPACING - ((t * 1.5) % SPACING);
    const first = Math.min(nav.follower.index, pts.length - 1);
    for (let i = first; i < pts.length && n < MAX_CHEVRONS; i++) {
      const px = pts[i].x;
      const pz = pts[i].z;
      const dx = px - cx;
      const dz = pz - cz;
      const len = Math.hypot(dx, dz);
      if (len > 1e-4) {
        const ux = dx / len;
        const uz = dz / len;
        const yaw = Math.atan2(-ux, -uz);
        let d = carry;
        while (d < len && n < MAX_CHEVRONS) {
          const x = cx + ux * d;
          const z = cz + uz * d;
          o.position.set(x, groundHeight(x, z) + 0.07, z);
          o.rotation.set(0, yaw, 0);
          const s = 0.85 + 0.15 * Math.sin(t * 4 - n * 0.7);
          o.scale.set(s, 1, s);
          o.updateMatrix();
          m.setMatrixAt(n, o.matrix);
          const dp = Math.hypot(x - runtime.local.x, z - runtime.local.z);
          const f = Math.min(1, dp / 2.5) * Math.max(0, 1 - Math.max(0, dp - 38) / 18);
          col.setRGB(0.25 * f, 0.9 * f, 1.0 * f);
          m.setColorAt(n, col);
          n++;
          d += SPACING;
        }
        carry = d - len;
      }
      cx = px;
      cz = pz;
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh ref={mesh} args={[geo, undefined as unknown as THREE.Material, MAX_CHEVRONS]} frustumCulled={false} renderOrder={3}>
        <meshBasicMaterial map={tex.chevron} transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} polygonOffset polygonOffsetFactor={-4} polygonOffsetUnits={-4} />
      </instancedMesh>
      {target && <Beam key={`${target.x},${target.z}`} x={target.x} z={target.z} color={NAV_COLOR} radius={0.42} />}
    </>
  );
}
