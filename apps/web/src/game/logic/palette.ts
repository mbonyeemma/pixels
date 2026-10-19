/** Deterministic avatar looks derived from a player id. Pure (no three.js). */

/** FNV-1a 32-bit string hash. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SKIN_TONES = ['#f6d5b8', '#efc29b', '#e0a878', '#c68642', '#a9703f', '#8d5524', '#6b4128', '#4a2c1a'] as const;
export const HAIR_COLORS = ['#1b1512', '#2e2018', '#4a3020', '#6b4423', '#8a5a2b', '#b8863b', '#d9b36a', '#a8352a', '#3a3a44', '#c9c9c9'] as const;
export const SHIRT_COLORS = ['#3f7cac', '#c8553d', '#4d9a64', '#e0b33a', '#7a5ca8', '#d67aa0', '#2f4858', '#e8e4dc', '#5bb3b0', '#d98b3a', '#8a9a3c', '#b23a48'] as const;
export const PANTS_COLORS = ['#2b3a55', '#3b3b40', '#5a4636', '#6b7a8f', '#1f2d24', '#7a6a58', '#46506b'] as const;
export const SHOE_COLORS = ['#f2f2f2', '#2a2a2e', '#7a4a2a', '#c04040', '#3d5a80'] as const;
export const HAIR_STYLES = ['short', 'long', 'spiky', 'bun', 'buzz', 'side'] as const;
export type HairStyle = (typeof HAIR_STYLES)[number];

export interface AvatarPalette {
  skin: string;
  hair: string;
  shirt: string;
  pants: string;
  shoes: string;
  hairStyle: HairStyle;
  /** overall body scale 0.95..1.05 */
  height: number;
  /** torso width factor 0.93..1.08 */
  build: number;
}

export function avatarPalette(id: string): AvatarPalette {
  const rng = mulberry32(hashString(id) ^ 0x9e3779b9);
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rng() * a.length) % a.length];
  const skin = pick(SKIN_TONES);
  const hair = pick(HAIR_COLORS);
  const shirt = pick(SHIRT_COLORS);
  let pants = pick(PANTS_COLORS);
  const shoes = pick(SHOE_COLORS);
  const hairStyle = pick(HAIR_STYLES);
  const height = 0.95 + rng() * 0.1;
  const build = 0.93 + rng() * 0.15;
  if ((pants as string) === (shirt as string)) pants = PANTS_COLORS[0];
  return { skin, hair, shirt, pants, shoes, hairStyle, height, build };
}
