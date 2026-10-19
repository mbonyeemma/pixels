import { describe, expect, it } from 'vitest';
import { avatarPalette, hashString, HAIR_STYLES, SKIN_TONES } from '../logic/palette';

describe('avatarPalette', () => {
  it('is deterministic per id', () => {
    expect(avatarPalette('player-123')).toEqual(avatarPalette('player-123'));
    expect(hashString('abc')).toBe(hashString('abc'));
  });
  it('differs between ids (most of the time)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) seen.add(JSON.stringify(avatarPalette('id' + i)));
    expect(seen.size).toBeGreaterThan(30);
  });
  it('stays inside the declared palettes and ranges', () => {
    for (let i = 0; i < 100; i++) {
      const p = avatarPalette('u' + i);
      expect(SKIN_TONES).toContain(p.skin);
      expect(HAIR_STYLES).toContain(p.hairStyle);
      expect(p.height).toBeGreaterThanOrEqual(0.95);
      expect(p.height).toBeLessThanOrEqual(1.05);
      expect(p.build).toBeGreaterThanOrEqual(0.93);
      expect(p.build).toBeLessThanOrEqual(1.08);
      expect(p.pants).not.toBe(p.shirt);
    }
  });
  it('hash matches the known FNV-1a vector', () => {
    expect(hashString('')).toBe(0x811c9dc5);
    expect(hashString('a')).toBe(0xe40c292c);
  });
});
