import { useEffect, useMemo, useRef, type ComponentRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Sky } from '@react-three/drei';
import * as THREE from 'three';
import { DAY_LENGTH_SEC, worldTimeOfDay } from '@pixels/shared';
import { runtime, useGame } from '../state';
import { computeSkyState } from './logic/daynight';
import { envCtl, skyState } from './env';
import { useTextures } from './assets';
import { createParticles } from './gfx/particles';

const SHADOW_EXTENT = 46;

export function currentTimeOfDay(): number {
  return envCtl.forceT ?? worldTimeOfDay(Date.now() + runtime.serverOffsetMs, DAY_LENGTH_SEC);
}

const nightVert = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * p;
    gl_Position.z = gl_Position.w * 0.99999;
  }`;
const nightFrag = /* glsl */ `
  uniform float uNight;
  uniform float uStars;
  uniform float uTime;
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uMoonDir;
  varying vec3 vDir;
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  void main() {
    vec3 d = normalize(vDir);
    float h = clamp(d.y, 0.0, 1.0);
    vec3 col = mix(uHorizon, uZenith, pow(h, 0.55));
    // stars
    vec3 p = d * 110.0;
    vec3 id = floor(p);
    vec3 f = fract(p) - 0.5;
    float r = hash13(id);
    vec3 off = vec3(hash13(id + 7.1), hash13(id + 13.7), hash13(id + 29.3)) - 0.5;
    float star = step(0.9, r) * smoothstep(0.16 + r * 0.1, 0.0, length(f - off * 0.5));
    float tw = 0.65 + 0.35 * sin(uTime * (1.5 + r * 4.0) + r * 60.0);
    float horizonFade = smoothstep(0.02, 0.22, d.y);
    vec3 starCol = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.92, 0.8), fract(r * 91.7));
    col += starCol * star * tw * horizonFade * uStars * (1.0 + 2.0 * step(0.985, r));
    // faint milky band
    float band = exp(-pow(dot(d, normalize(vec3(0.3, 0.8, 0.5))) * 4.0, 2.0));
    col += vec3(0.05, 0.06, 0.1) * band * uStars * horizonFade;
    // moon
    float md = dot(d, uMoonDir);
    float disc = smoothstep(0.99935, 0.99965, md);
    float glow = pow(max(md, 0.0), 220.0) * 0.55 + pow(max(md, 0.0), 24.0) * 0.12;
    vec3 moonCol = vec3(0.93, 0.95, 1.0);
    float up = smoothstep(-0.02, 0.06, uMoonDir.y);
    col += (moonCol * disc * 1.6 + vec3(0.45, 0.55, 0.85) * glow) * uStars * up;
    gl_FragColor = vec4(col, uNight);
  }`;

/** Sky (drei <Sky>), night dome with stars/moon, hemisphere + sun/moon light with a camera-following shadow map, fog, lamp lights. */
export default function Environment({ lamps }: { lamps: THREE.Vector3[] }) {
  const tex = useTextures();
  void tex;
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  const quality = useGame((s) => s.quality);
  const sun = useRef<THREE.DirectionalLight>(null);
  const sunTarget = useMemo(() => new THREE.Object3D(), []);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const sky = useRef<ComponentRef<typeof Sky>>(null);
  const dome = useRef<THREE.Mesh>(null);
  const lampLights = useRef<(THREE.PointLight | null)[]>([null, null, null]);
  const fog = useMemo(() => new THREE.Fog('#c3d8ea', 60, 430), []);
  const sunPos = useMemo(() => new THREE.Vector3(), []);
  const snap = useMemo(() => ({ right: new THREE.Vector3(), up: new THREE.Vector3(), t: new THREE.Vector3(), d: new THREE.Vector3() }), []);
  const col = useMemo(() => new THREE.Color(), []);
  const hi = quality === 'high';
  const clouds = useMemo(() => {
    const rnd = (n: number) => {
      const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
      return x - Math.floor(x);
    };
    return createParticles({
      count: 14 * 8,
      map: tex.softCircle,
      color: '#ffffff',
      header: 'uniform vec3 uCam; uniform float uDay;',
      uniforms: { uCam: { value: new THREE.Vector3() }, uDay: { value: 1 } },
      seedFn: (i, s) => {
        const c = Math.floor(i / 8);
        const p = i % 8;
        s[0] = (c + rnd(c + 1) * 0.6) / 14;
        s[1] = rnd(c + 50);
        s[2] = (p / 7 - 0.5) * 2 * (0.6 + rnd(c + 90) * 0.6) + (rnd(i + 7) - 0.5) * 0.25;
        s[3] = rnd(i + 200);
      },
      motion: `
        float az = seed.x * 6.2831 + t * 0.004;
        float el = 0.1 + seed.y * 0.38;
        vec3 dir = vec3(cos(az) * cos(el), sin(el), sin(az) * cos(el));
        vec3 rightV = vec3(-sin(az), 0.0, cos(az));
        float dome = 1.0 - seed.z * seed.z;
        center = uCam + dir * 800.0 + rightV * seed.z * 150.0 + vec3(0.0, dome * 22.0 + (seed.w - 0.5) * 18.0, 0.0);
        size = 90.0 + seed.w * 80.0 + dome * 40.0;
        alpha = 0.5 * uDay * smoothstep(0.03, 0.16, el) * (0.55 + 0.45 * seed.w);
      `,
    });
  }, [tex]);
  useEffect(() => () => clouds.dispose(), [clouds]);

  useEffect(() => {
    if (sky.current) sky.current.renderOrder = -2;
  }, []);

  useEffect(() => {
    scene.fog = fog;
    return () => {
      scene.fog = null;
    };
  }, [scene, fog]);

  const nightMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: nightVert,
        fragmentShader: nightFrag,
        transparent: true,
        depthWrite: false,
        side: THREE.BackSide,
        fog: false,
        uniforms: {
          uNight: { value: 0 },
          uStars: { value: 0 },
          uTime: { value: 0 },
          uHorizon: { value: new THREE.Color('#0b1328') },
          uZenith: { value: new THREE.Color('#050816') },
          uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
        },
      }),
    [],
  );
  useEffect(() => () => nightMat.dispose(), [nightMat]);

  useEffect(() => {
    const l = sun.current;
    if (!l) return;
    l.castShadow = hi;
    l.shadow.mapSize.set(hi ? 2048 : 512, hi ? 2048 : 512);
    l.shadow.map?.dispose();
    (l.shadow as unknown as { map: THREE.WebGLRenderTarget | null }).map = null;
    const c = l.shadow.camera;
    c.left = -SHADOW_EXTENT;
    c.right = SHADOW_EXTENT;
    c.top = SHADOW_EXTENT;
    c.bottom = -SHADOW_EXTENT;
    c.near = 5;
    c.far = 320;
    c.updateProjectionMatrix();
    l.shadow.bias = -0.00035;
    l.shadow.normalBias = 0.05;
  }, [hi]);

  useFrame((state) => {
    const t = currentTimeOfDay();
    const s = computeSkyState(t, skyState);
    const cam = state.camera;
    // ---- fog + renderer
    fog.color.setRGB(s.fog[0], s.fog[1], s.fog[2], THREE.SRGBColorSpace);
    fog.near = s.fogNear;
    fog.far = s.fogFar;
    gl.setClearColor(fog.color);
    gl.toneMappingExposure = s.exposure * 1.0;
    // ---- hemisphere
    const h = hemi.current;
    if (h) {
      h.color.setRGB(s.hemiSky[0], s.hemiSky[1], s.hemiSky[2], THREE.SRGBColorSpace);
      h.groundColor.setRGB(s.hemiGround[0], s.hemiGround[1], s.hemiGround[2], THREE.SRGBColorSpace);
      h.intensity = s.hemiIntensity;
    }
    // ---- sun / moon light, snapped to shadow texels around the player
    const l = sun.current;
    if (l) {
      const px = runtime.local.x;
      const pz = runtime.local.z;
      snap.d.set(s.lightDir[0], s.lightDir[1], s.lightDir[2]).normalize();
      snap.right.set(0, 1, 0).cross(snap.d).normalize();
      snap.up.copy(snap.d).cross(snap.right).normalize();
      const texel = (SHADOW_EXTENT * 2) / l.shadow.mapSize.x;
      snap.t.set(px, 0, pz);
      const a = Math.round(snap.t.dot(snap.right) / texel) * texel;
      const b = Math.round(snap.t.dot(snap.up) / texel) * texel;
      snap.t.set(0, 0, 0).addScaledVector(snap.right, a).addScaledVector(snap.up, b);
      // keep the (unsnapped) component along the light direction at ground level
      const along = new THREE.Vector3(px, 0, pz).dot(snap.d);
      snap.t.addScaledVector(snap.d, along);
      l.target.position.copy(snap.t);
      l.position.copy(snap.t).addScaledVector(snap.d, 150);
      l.target.updateMatrixWorld();
      l.color.setRGB(s.lightColor[0], s.lightColor[1], s.lightColor[2], THREE.SRGBColorSpace);
      l.intensity = s.lightIntensity;
      l.castShadow = hi && s.lightIntensity > 0.02;
    }
    // ---- sky
    const sk = sky.current;
    if (sk) {
      sunPos.set(s.sunDir[0], s.sunDir[1], s.sunDir[2]).multiplyScalar(400000);
      const u = (sk.material as THREE.ShaderMaterial).uniforms;
      u.sunPosition.value.copy(sunPos);
      u.rayleigh.value = 1.1 + s.dusk * 2.2;
      u.turbidity.value = 3.2 + s.dusk * 5;
      u.mieCoefficient.value = 0.004 + s.dusk * 0.004;
      sk.position.copy(cam.position);
    }
    // ---- clouds drift around the camera, lit by the sun colour
    {
      const cu = clouds.material.uniforms;
      (cu.uCam.value as THREE.Vector3).copy(cam.position);
      cu.uDay.value = Math.min(1, s.day * 1.1);
      (cu.uColor.value as THREE.Color).setRGB(
        0.82 + 0.18 * s.sunColor[0] + 0.1 * s.dusk, 0.84 + 0.12 * s.sunColor[1] - 0.1 * s.dusk, 0.9 + 0.1 * s.sunColor[2] - 0.28 * s.dusk, THREE.SRGBColorSpace,
      );
      clouds.update(state.clock.elapsedTime, 0.45 + 0.55 * s.day);
      clouds.mesh.visible = s.day > 0.02;
    }
    // ---- night dome follows the camera
    const d = dome.current;
    if (d) {
      d.position.copy(cam.position);
      nightMat.uniforms.uNight.value = Math.min(1, s.night * 1.15);
      nightMat.uniforms.uStars.value = s.starAlpha;
      nightMat.uniforms.uTime.value = state.clock.elapsedTime;
      (nightMat.uniforms.uHorizon.value as THREE.Color).setRGB(s.fog[0], s.fog[1], s.fog[2], THREE.SRGBColorSpace);
      (nightMat.uniforms.uZenith.value as THREE.Color).setRGB(s.hemiSky[0] * 0.28, s.hemiSky[1] * 0.28, s.hemiSky[2] * 0.4, THREE.SRGBColorSpace);
      (nightMat.uniforms.uMoonDir.value as THREE.Vector3).set(s.moonDir[0], s.moonDir[1], s.moonDir[2]).normalize();
      d.visible = s.night > 0.01;
    }
    // ---- real lights on the three lamps nearest the player
    const px = runtime.local.x;
    const pz = runtime.local.z;
    const lights = lampLights.current;
    if (lights[0]) {
      // pick 3 nearest (tiny selection, no allocation)
      let i0 = -1, i1 = -1, i2 = -1;
      let d0 = Infinity, d1 = Infinity, d2 = Infinity;
      for (let i = 0; i < lamps.length; i++) {
        const dd = (lamps[i].x - px) ** 2 + (lamps[i].z - pz) ** 2;
        if (dd < d0) { i2 = i1; d2 = d1; i1 = i0; d1 = d0; i0 = i; d0 = dd; }
        else if (dd < d1) { i2 = i1; d2 = d1; i1 = i; d1 = dd; }
        else if (dd < d2) { i2 = i; d2 = dd; }
      }
      const idx = [i0, i1, i2];
      for (let k = 0; k < 3; k++) {
        const pl = lights[k];
        if (!pl) continue;
        const lamp = idx[k] >= 0 ? lamps[idx[k]] : null;
        if (lamp) pl.position.copy(lamp);
        pl.intensity = lamp ? s.lampOn * 26 : 0;
      }
    }
    void col;
  });

  return (
    <>
      <hemisphereLight ref={hemi} intensity={1.5} />
      <directionalLight ref={sun} intensity={3} castShadow target={sunTarget} />
      <primitive object={sunTarget} />
      <Sky ref={sky} distance={800} sunPosition={[0, 1, 0]} turbidity={3} rayleigh={1.1} mieCoefficient={0.004} mieDirectionalG={0.85} />
      <mesh ref={dome} renderOrder={-1} frustumCulled={false} material={nightMat}>
        <sphereGeometry args={[1200, 32, 16]} />
      </mesh>
      <primitive object={clouds.mesh} />
      {[0, 1, 2].map((i) => (
        <pointLight key={i} ref={(el) => { lampLights.current[i] = el; }} color="#ffb766" intensity={0} distance={16} decay={1.6} />
      ))}
    </>
  );
}
