/** Day/night lighting curves driven by time of day t in [0,1) (0 = midnight, 0.5 = noon). Pure. */

export type RGB = [number, number, number];

export interface SkyState {
  t: number;
  /** sun height in [-1,1] (sin of the sun angle) */
  h: number;
  /** unit vector pointing towards the sun (also when below the horizon) */
  sunDir: [number, number, number];
  moonDir: [number, number, number];
  /** 0 at night .. 1 in full daylight */
  day: number;
  /** 0 by day .. 1 at night (used for stars) */
  night: number;
  /** lamps / lit windows strength 0..1 */
  lampOn: number;
  windowGlow: number;
  starAlpha: number;
  /** warm horizon glow strength 0..1 */
  dusk: number;
  hemiSky: RGB;
  hemiGround: RGB;
  hemiIntensity: number;
  fog: RGB;
  fogNear: number;
  fogFar: number;
  /** the directional light that casts shadows: sun by day, moon by night */
  lightDir: [number, number, number];
  lightColor: RGB;
  lightIntensity: number;
  sunColor: RGB;
  moonIntensity: number;
  exposure: number;
}

const hex = (s: string): RGB => {
  const n = parseInt(s.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

interface Key {
  h: number;
  sky: RGB;
  ground: RGB;
  hemi: number;
  fog: RGB;
  fogNear: number;
  fogFar: number;
  sun: RGB;
  sunI: number;
  exposure: number;
}
const K = (h: number, sky: string, ground: string, hemi: number, fog: string, fogNear: number, fogFar: number, sun: string, sunI: number, exposure: number): Key => ({
  h, sky: hex(sky), ground: hex(ground), hemi, fog: hex(fog), fogNear, fogFar, sun: hex(sun), sunI, exposure,
});

// keyframes by sun height; values interpolate linearly between them
const KEYS: Key[] = [
  K(-0.45, '#1a2850', '#0e1220', 0.75, '#0b1328', 28, 360, '#6f8cff', 0, 0.95),
  K(-0.16, '#2a3c70', '#141824', 0.8, '#1a2548', 30, 360, '#ff8a4c', 0, 0.98),
  K(-0.05, '#5e5688', '#2c2832', 0.95, '#7a5f78', 32, 360, '#ff6a2a', 0.0, 1.0),
  K(0.0, '#b88f90', '#4c4036', 1.1, '#d9906a', 35, 320, '#ff7a35', 0.9, 1.0),
  K(0.07, '#c4a898', '#5a4c3a', 1.3, '#e8b98c', 40, 360, '#ff9c58', 2.0, 1.0),
  K(0.18, '#b4c8e2', '#7a7254', 1.4, '#cfd9df', 50, 400, '#ffd8aa', 2.8, 1.0),
  K(0.4, '#b8cde8', '#847a5c', 1.5, '#c8d9ea', 60, 430, '#fff0da', 3.1, 0.95),
  K(1.0, '#b6cbea', '#847a5c', 1.5, '#c4d8ee', 60, 440, '#fff6e8', 3.2, 0.95),
];

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const mixRGB = (a: RGB, b: RGB, t: number, out: RGB): RGB => {
  out[0] = mix(a[0], b[0], t);
  out[1] = mix(a[1], b[1], t);
  out[2] = mix(a[2], b[2], t);
  return out;
};

const MOON_COLOR = hex('#9db4ff');

export function makeSkyState(): SkyState {
  return {
    t: 0, h: 0, sunDir: [0, 1, 0], moonDir: [0, -1, 0], day: 1, night: 0, lampOn: 0, windowGlow: 0, starAlpha: 0, dusk: 0,
    hemiSky: [1, 1, 1], hemiGround: [0.5, 0.5, 0.5], hemiIntensity: 1, fog: [0.7, 0.8, 0.9], fogNear: 60, fogFar: 400,
    lightDir: [0, 1, 0], lightColor: [1, 1, 1], lightIntensity: 1, sunColor: [1, 1, 1], moonIntensity: 0, exposure: 1,
  };
}

/** Compute the sky/lighting state for time of day `t` (wraps). Writes into `out` and returns it. */
export function computeSkyState(tIn: number, out: SkyState = makeSkyState()): SkyState {
  const t = ((tIn % 1) + 1) % 1;
  const a = (t - 0.25) * Math.PI * 2; // 0 sunrise (east), PI/2 noon, PI sunset
  const h = Math.sin(a);
  // sun direction: east->west arc, tilted a little to the south so noon shadows fall to the north
  let sx = Math.cos(a);
  let sy = h * 0.82 + (h < 0 ? 0 : 0);
  let sz = 0.42;
  const sl = Math.hypot(sx, sy, sz);
  sx /= sl; sy /= sl; sz /= sl;
  out.t = t;
  out.h = h;
  out.sunDir[0] = sx; out.sunDir[1] = sy; out.sunDir[2] = sz;
  // the moon trails the sun by half a day
  out.moonDir[0] = -sx; out.moonDir[1] = -sy; out.moonDir[2] = sz;

  // keyframe interpolation
  let i = 0;
  while (i < KEYS.length - 2 && h > KEYS[i + 1].h) i++;
  const k0 = KEYS[i];
  const k1 = KEYS[i + 1];
  const u = Math.min(1, Math.max(0, (h - k0.h) / (k1.h - k0.h)));
  mixRGB(k0.sky, k1.sky, u, out.hemiSky);
  mixRGB(k0.ground, k1.ground, u, out.hemiGround);
  out.hemiIntensity = mix(k0.hemi, k1.hemi, u);
  mixRGB(k0.fog, k1.fog, u, out.fog);
  out.fogNear = mix(k0.fogNear, k1.fogNear, u);
  out.fogFar = mix(k0.fogFar, k1.fogFar, u);
  mixRGB(k0.sun, k1.sun, u, out.sunColor);
  const sunI = mix(k0.sunI, k1.sunI, u);
  out.exposure = mix(k0.exposure, k1.exposure, u);

  out.day = smoothstep(-0.06, 0.28, h);
  out.night = 1 - smoothstep(-0.2, 0.04, h);
  out.lampOn = 1 - smoothstep(-0.07, 0.13, h);
  out.windowGlow = 1 - smoothstep(-0.05, 0.1, h);
  out.starAlpha = 1 - smoothstep(-0.32, -0.04, h);
  out.dusk = Math.max(0, 1 - Math.abs(h - 0.02) / 0.2);

  // moon light at night
  const moonK = 1 - smoothstep(-0.28, -0.06, h);
  out.moonIntensity = 0.75 * moonK;
  // pick the shadow caster: sun while it has any strength, else moon
  const sunUp = h > -0.045;
  if (sunUp) {
    out.lightDir[0] = sx; out.lightDir[1] = sy; out.lightDir[2] = sz;
    out.lightColor[0] = out.sunColor[0]; out.lightColor[1] = out.sunColor[1]; out.lightColor[2] = out.sunColor[2];
    out.lightIntensity = sunI * smoothstep(-0.045, 0.01, h);
  } else {
    out.lightDir[0] = -sx; out.lightDir[1] = -sy; out.lightDir[2] = sz;
    out.lightColor[0] = MOON_COLOR[0]; out.lightColor[1] = MOON_COLOR[1]; out.lightColor[2] = MOON_COLOR[2];
    out.lightIntensity = out.moonIntensity;
  }
  return out;
}
