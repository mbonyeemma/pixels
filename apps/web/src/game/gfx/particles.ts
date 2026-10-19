import * as THREE from 'three';

/**
 * GPU billboard particle system. All motion is computed in the vertex shader from per-instance seeds, so there is
 * no per-frame CPU work except updating `uTime` / `uLight`.
 *
 * `motion` is a GLSL snippet that must define `vec3 center`, `float size`, `float alpha` from `seed` (vec4 in [0,1))
 * and `t` (seconds). `color` is a linear RGB multiplier.
 */
export interface ParticleOptions {
  count: number;
  motion: string;
  map: THREE.Texture;
  color: THREE.ColorRepresentation;
  additive?: boolean;
  seedFn?: (i: number, out: [number, number, number, number]) => void;
  uniforms?: Record<string, THREE.IUniform>;
}

export interface ParticleSystem {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  update(time: number, light: number): void;
  dispose(): void;
}

export function createParticles(o: ParticleOptions): ParticleSystem {
  const base = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.setAttribute('position', base.getAttribute('position'));
  g.setAttribute('uv', base.getAttribute('uv'));
  const seeds = new Float32Array(o.count * 4);
  const tmp: [number, number, number, number] = [0, 0, 0, 0];
  let s = 12345;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < o.count; i++) {
    tmp[0] = rnd(); tmp[1] = rnd(); tmp[2] = rnd(); tmp[3] = rnd();
    o.seedFn?.(i, tmp);
    seeds.set(tmp, i * 4);
  }
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  g.instanceCount = o.count;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e5);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uLight: { value: 1 },
      uMap: { value: o.map },
      uColor: { value: new THREE.Color(o.color) },
      ...(o.uniforms ?? {}),
    },
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float uTime;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        vec4 seed = aSeed;
        float t = uTime;
        vec3 center = vec3(0.0);
        float size = 0.1;
        float alpha = 1.0;
        ${o.motion}
        vec4 mv = modelViewMatrix * vec4(center, 1.0);
        mv.xy += position.xy * size;
        vUv = uv;
        vAlpha = alpha;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uColor;
      uniform float uLight;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        vec4 tex = texture2D(uMap, vUv);
        float a = tex.a * vAlpha;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor * uLight, a);
      }`,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  return {
    mesh,
    material: mat,
    update(time, light) {
      mat.uniforms.uTime.value = time;
      mat.uniforms.uLight.value = light;
    },
    dispose() {
      g.dispose();
      base.dispose();
      mat.dispose();
    },
  };
}
