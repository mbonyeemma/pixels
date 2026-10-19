import { describe, expect, it } from 'vitest';
import { computeSkyState, makeSkyState } from '../logic/daynight';

describe('computeSkyState', () => {
  it('is full day with the sun high at noon', () => {
    const s = computeSkyState(0.5);
    expect(s.h).toBeCloseTo(1, 5);
    expect(s.sunDir[1]).toBeGreaterThan(0.7);
    expect(s.day).toBeCloseTo(1, 3);
    expect(s.lampOn).toBe(0);
    expect(s.starAlpha).toBe(0);
    expect(s.lightIntensity).toBeGreaterThan(2.5);
  });
  it('is dark with lamps and stars at midnight, lit by the moon', () => {
    const s = computeSkyState(0);
    expect(s.h).toBeCloseTo(-1, 5);
    expect(s.day).toBe(0);
    expect(s.lampOn).toBe(1);
    expect(s.windowGlow).toBe(1);
    expect(s.starAlpha).toBe(1);
    expect(s.lightDir[1]).toBeGreaterThan(0.3); // moon is up
    expect(s.lightIntensity).toBeGreaterThan(0.3);
    expect(s.lightIntensity).toBeLessThan(1.2);
    expect(s.fog[2]).toBeGreaterThan(s.fog[0]); // bluish night fog
  });
  it('sun rises in the east (+x) and sets in the west (-x)', () => {
    expect(computeSkyState(0.3).sunDir[0]).toBeGreaterThan(0);
    expect(computeSkyState(0.7).sunDir[0]).toBeLessThan(0);
  });
  it('turns lamps on around dusk and off after dawn', () => {
    expect(computeSkyState(0.745).lampOn).toBeGreaterThan(0.1);
    expect(computeSkyState(0.6).lampOn).toBe(0);
    expect(computeSkyState(0.78).lampOn).toBeGreaterThan(0.9);
    expect(computeSkyState(0.3).lampOn).toBeLessThan(0.05);
  });
  it('has warm light near the horizon', () => {
    const s = computeSkyState(0.255);
    expect(s.sunColor[0]).toBeGreaterThan(s.sunColor[2]);
    expect(s.dusk).toBeGreaterThan(0.5);
  });
  it('is continuous (no big jumps) and wraps', () => {
    let prev = computeSkyState(0);
    const tmp = makeSkyState();
    for (let i = 1; i <= 2000; i++) {
      const s = computeSkyState(i / 2000, tmp);
      expect(Math.abs(s.lightIntensity - prev.lightIntensity)).toBeLessThan(0.2);
      expect(Math.abs(s.hemiIntensity - prev.hemiIntensity)).toBeLessThan(0.05);
      for (let c = 0; c < 3; c++) expect(Math.abs(s.fog[c] - prev.fog[c])).toBeLessThan(0.03);
      prev = { ...s, fog: [...s.fog], sunDir: [...s.sunDir], moonDir: [...s.moonDir], lightDir: [...s.lightDir], lightColor: [...s.lightColor], sunColor: [...s.sunColor], hemiSky: [...s.hemiSky], hemiGround: [...s.hemiGround] } as typeof s;
    }
    expect(computeSkyState(1.5).t).toBeCloseTo(0.5, 6);
    expect(computeSkyState(-0.25).t).toBeCloseTo(0.75, 6);
  });
});
