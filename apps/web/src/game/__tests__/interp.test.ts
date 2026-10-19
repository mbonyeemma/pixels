import { describe, expect, it } from 'vitest';
import { angleDiff, effectiveAnim, lerpAngle, pruneSnapshots, sampleSnapshots, type SampledPose, type Snapshot } from '../logic/interp';

const out = (): SampledPose => ({ x: 0, z: 0, ry: 0, anim: 'idle', speed: 0 });
const snap = (t: number, x: number, z = 0, ry = 0, anim: Snapshot['anim'] = 'walk'): Snapshot => ({ t, x, z, ry, anim });

describe('sampleSnapshots', () => {
  it('returns false for an empty buffer', () => {
    expect(sampleSnapshots([], 10, out())).toBe(false);
  });
  it('interpolates between bracketing entries using the render delay', () => {
    const buf = [snap(1.0, 0), snap(1.1, 1), snap(1.2, 2)];
    const o = out();
    expect(sampleSnapshots(buf, 1.17, o, 0.12)).toBe(true); // render time 1.05
    expect(o.x).toBeCloseTo(0.5, 5);
    expect(o.speed).toBeCloseTo(10, 4);
  });
  it('clamps to the oldest entry when render time precedes the buffer', () => {
    const o = out();
    sampleSnapshots([snap(5, 3, 4), snap(5.1, 4, 4)], 5.05, o);
    expect(o.x).toBe(3);
    expect(o.speed).toBe(0);
  });
  it('extrapolates at most 150 ms and then holds', () => {
    const buf = [snap(1.0, 0), snap(1.1, 1)]; // 10 m/s
    const o = out();
    sampleSnapshots(buf, 1.1 + 0.12 + 0.05, o); // 50 ms past newest
    expect(o.x).toBeCloseTo(1.5, 4);
    sampleSnapshots(buf, 1.1 + 0.12 + 1.0, o); // way past: capped at 150 ms
    expect(o.x).toBeCloseTo(2.5, 4);
    expect(o.speed).toBe(0);
  });
  it('does not extrapolate stale data', () => {
    const buf = [snap(1.0, 0), snap(1.1, 1)];
    const o = out();
    sampleSnapshots(buf, 10, o);
    expect(o.x).toBe(1);
  });
  it('snaps across teleports', () => {
    const buf = [snap(1.0, 0), snap(1.1, 50)];
    const o = out();
    sampleSnapshots(buf, 1.15, o, 0.12);
    expect(o.x).toBe(50);
  });
  it('interpolates rotation along the shortest arc', () => {
    expect(lerpAngle(3.0, -3.0, 0.5)).toBeCloseTo(Math.PI, 1);
    expect(Math.abs(angleDiff(0.1, Math.PI * 2 - 0.1))).toBeCloseTo(0.2, 5);
    const buf = [snap(1.0, 0, 0, 3.0), snap(1.2, 0, 0, -3.0)];
    const o = out();
    sampleSnapshots(buf, 1.22, o, 0.12);
    expect(Math.abs(Math.abs(o.ry) - Math.PI)).toBeLessThan(0.2);
  });
});

describe('pruneSnapshots / effectiveAnim', () => {
  it('keeps at least two entries and drops old ones', () => {
    const buf = [snap(1, 0), snap(2, 0), snap(3, 0), snap(9.9, 0), snap(10, 0)];
    pruneSnapshots(buf, 10, 1.5);
    expect(buf.map((b) => b.t)).toEqual([3, 9.9, 10]);
    const tiny = [snap(1, 0), snap(2, 0)];
    pruneSnapshots(tiny, 100, 1);
    expect(tiny.length).toBe(2);
  });
  it('derives locomotion from speed and keeps emotes', () => {
    expect(effectiveAnim('idle', 0)).toBe('idle');
    expect(effectiveAnim('walk', 0.1)).toBe('idle');
    expect(effectiveAnim('idle', 3)).toBe('walk');
    expect(effectiveAnim('walk', 5.5)).toBe('run');
    expect(effectiveAnim('dance', 0)).toBe('dance');
    expect(effectiveAnim('wave', 3)).toBe('wave');
  });
});
