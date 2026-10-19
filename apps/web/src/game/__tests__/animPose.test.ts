import { describe, expect, it } from 'vitest';
import { gaitFor, makePose, targetPose } from '../logic/animPose';

describe('targetPose', () => {
  it('running swings the legs and arms more than walking, idle not at all', () => {
    const walk = targetPose('walk', 0, Math.PI / 2, 3.2, makePose());
    const run = targetPose('run', 0, Math.PI / 2, 6, makePose());
    const idle = targetPose('idle', 0.3, 0, 0, makePose());
    expect(Math.abs(run.legLSwing)).toBeGreaterThan(Math.abs(walk.legLSwing));
    expect(Math.abs(run.armLSwing)).toBeGreaterThan(Math.abs(walk.armLSwing));
    expect(run.spineX).toBeGreaterThan(walk.spineX);
    expect(Math.abs(idle.legLSwing)).toBe(0);
  });
  it('legs and arms are in anti-phase', () => {
    const p = targetPose('walk', 0, 1, 3.2, makePose());
    expect(p.legLSwing).toBeCloseTo(-p.legRSwing, 6);
    expect(Math.sign(p.legLSwing)).toBe(-Math.sign(p.armLSwing));
  });
  it('emotes raise the arms', () => {
    expect(targetPose('wave', 1, 0, 0, makePose()).armRAbd).toBeGreaterThan(2);
    expect(targetPose('cheer', 1, 0, 0, makePose()).armLAbd).toBeGreaterThan(2.3);
    expect(targetPose('dance', 1, 0, 0, makePose()).armLAbd).toBeGreaterThan(0.4);
  });
  it('gait cadence grows with speed and is zero at rest', () => {
    expect(gaitFor(0).omega).toBe(0);
    expect(gaitFor(6).amp).toBeGreaterThan(gaitFor(3.2).amp);
    expect(gaitFor(6).omega).toBeGreaterThan(gaitFor(3.2).omega);
  });
});
