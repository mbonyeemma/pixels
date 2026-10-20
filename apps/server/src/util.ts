import { createHash, randomBytes } from 'node:crypto';

/** Injectable wall clock (ms since epoch). Everything time-dependent in the server takes one so tests are deterministic. */
export type Clock = () => number;
export const systemClock: Clock = () => Date.now();

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
export const randomHex = (bytes: number): string => randomBytes(bytes).toString('hex');

/** UTC day key, e.g. "2026-10-19" (used for per-day reward totals). */
export const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const round = (n: number, decimals = 0): number => {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
};

export const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

export const dist2d = (ax: number, az: number, bx: number, bz: number): number => Math.hypot(ax - bx, az - bz);

/** Wrap an angle (radians) into [-PI, PI]. Non-finite input becomes 0. */
export function normalizeAngle(a: number): number {
  if (!Number.isFinite(a)) return 0;
  const twoPi = Math.PI * 2;
  let r = (a + Math.PI) % twoPi;
  if (r < 0) r += twoPi;
  return r - Math.PI;
}

/**
 * Clean player-provided text: collapse whitespace, strip control / invisible / bidi-override characters,
 * trim, and cut to `maxLen` code points. Links are intentionally left alone.
 */
export function sanitizeText(input: string, maxLen: number): string {
  let s = input.replace(/\s+/g, ' ');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g, '');
  s = s.replace(/ {2,}/g, ' ').trim();
  const chars = Array.from(s);
  if (chars.length > maxLen) s = chars.slice(0, maxLen).join('').trimEnd();
  return s;
}

/** Normalised email key: trimmed + lowercased. */
export const emailKey = (email: string): string => email.trim().toLowerCase();
