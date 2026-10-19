import { describe, expect, it } from 'vitest';
import { createFollower, makeSteerOut, steerAlongPath, pathRemaining } from '../logic/steer';

describe('steerAlongPath', () => {
  const pts = [{ x: 10, z: 0 }, { x: 10, z: 20 }];
  it('heads for the first waypoint and runs when far', () => {
    const f = createFollower();
    const o = steerAlongPath(f, 0, 0, pts, 0.016, makeSteerOut());
    expect(o.status).toBe('moving');
    expect(o.dirX).toBeCloseTo(1, 5);
    expect(o.run).toBe(true);
  });
  it('advances the waypoint within 1 m and walks when the rest is short', () => {
    const f = createFollower();
    const o = makeSteerOut();
    steerAlongPath(f, 9.5, 0, [{ x: 10, z: 0 }, { x: 10, z: 5 }], 0.016, o);
    expect(f.index).toBe(1);
    expect(o.dirZ).toBeCloseTo(1, 1);
    expect(o.run).toBe(false);
  });
  it('arrives within 1.2 m of the end', () => {
    const f = createFollower();
    const o = steerAlongPath(f, 10, 19, pts, 0.016, makeSteerOut());
    expect(o.status).toBe('arrived');
  });
  it('reports blocked after 2 s without progress', () => {
    const f = createFollower();
    const o = makeSteerOut();
    let status = 'moving';
    for (let i = 0; i < 200; i++) {
      steerAlongPath(f, 0, 0, pts, 0.016, o);
      status = o.status;
      if (status !== 'moving') break;
    }
    expect(status).toBe('blocked');
  });
  it('does not report blocked while making progress', () => {
    const f = createFollower();
    const o = makeSteerOut();
    let x = 0;
    for (let i = 0; i < 400; i++) {
      steerAlongPath(f, x, 0, [{ x: 40, z: 0 }], 0.016, o);
      expect(o.status).toBe('moving');
      x += 3.2 * 0.016;
    }
  });
  it('counts a blocked end as arrived when already close', () => {
    const f = createFollower();
    const o = makeSteerOut();
    for (let i = 0; i < 200; i++) {
      steerAlongPath(f, 7.8, 0, [{ x: 10, z: 0 }], 0.016, o);
      if (o.status !== 'moving') break;
    }
    expect(o.status).toBe('arrived');
  });
  it('computes remaining length', () => {
    expect(pathRemaining(0, 0, [{ x: 3, z: 4 }, { x: 3, z: 14 }], 0)).toBeCloseTo(15, 5);
  });
});
