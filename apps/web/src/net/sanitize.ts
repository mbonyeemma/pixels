import { CHAT_MAX_LENGTH } from '@pixels/shared';

// C0/C1 controls, zero-width + bidi override/isolate characters, BOM, line/paragraph separators.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f​-‏ -‮⁠-⁩﻿]/g;

/**
 * Normalises user-typed or received chat text: strips control and invisible/bidi characters, collapses
 * whitespace, trims and caps to `max` code points. React escapes text on render; this is defence in depth
 * and keeps lines readable.
 */
export function sanitizeChat(input: unknown, max: number = CHAT_MAX_LENGTH): string {
  if (typeof input !== 'string') return '';
  const cleaned = input.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(cleaned);
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() : cleaned;
}

/** Player display names: same treatment, short cap. */
export const sanitizeName = (input: unknown): string => sanitizeChat(input, 40);

/** Deterministic hue (0-359) from a string, for colouring player names. */
export function hashHue(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}
