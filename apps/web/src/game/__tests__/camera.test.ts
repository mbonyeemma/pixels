import { describe, expect, it } from 'vitest';
import { BUILDINGS } from '@pixels/shared';
import { cameraClearDistance, clampDist, clampPitch, orbitDir, rayBoxEntry, DIST_MAX, DIST_MIN, PITCH_MAX, PITCH_MIN } from '../logic/camera';
import { buildCameraBoxes } from '../logic/world';
import { groundHeight, SIDEWALK_H } from '../logic/layout';

describe('camera helpers', () => {
  it('clamps pitch and distance', () => {
    expect(clampPitch(-1)).toBe(PITCH_MIN);
    expect(clampPitch(5)).toBe(PITCH_MAX);
    expect(clampDist(1)).toBe(DIST_MIN);
    expect(clampDist(99)).toBe(DIST_MAX);
  });
  it('yaw 0 puts the camera on +z (looking north)', () => {
    const d = { x: 0, y: 0, z: 0 };
    orbitDir(0, 0, d);
    expect(d.z).toBeCloseTo(1, 6);
    orbitDir(Math.PI / 2, 0, d);
    expect(d.x).toBeCloseTo(1, 6);
  });
  it('ray/box entry', () => {
    const b = { minX: 0, maxX: 2, minY: 0, maxY: 2, minZ: 0, maxZ: 2 };
    expect(rayBoxEntry(-3, 1, 1, 1, 0, 0, b, 10)).toBeCloseTo(3, 6);
    expect(rayBoxEntry(-3, 5, 1, 1, 0, 0, b, 10)).toBe(Infinity);
    expect(rayBoxEntry(-3, 1, 1, 1, 0, 0, b, 2)).toBe(Infinity);
  });
  it('shortens the camera distance in front of a building, not when it is above or beside it', () => {
    const boxes = buildCameraBoxes();
    const bk = BUILDINGS.find((b) => b.id === 'bakery')!;
    // player on the sidewalk in front of the bakery (z=-8.5), camera pushed north into the building
    const px = bk.x; const pz = -8.5;
    const d = cameraClearDistance(px, 1.6, pz, 0, 0.2, -0.98, 8, boxes);
    expect(d).toBeLessThan(3);
    expect(d).toBeGreaterThanOrEqual(0.9);
    // camera swinging to the south is unobstructed
    expect(cameraClearDistance(px, 1.6, pz, 0, 0.5, 0.86, 8, boxes)).toBe(8);
    // high camera looking down over the roof passes above
    expect(cameraClearDistance(px, 1.6, pz, 0, 1, 0, 8, boxes)).toBe(8);
  });
});

describe('groundHeight', () => {
  it('is raised on sidewalks and flat on the road', () => {
    expect(groundHeight(0, 0)).toBe(0);
    expect(groundHeight(20, 7)).toBeCloseTo(SIDEWALK_H, 6);
    expect(groundHeight(1.5, 20)).toBeCloseTo(SIDEWALK_H, 6);
    expect(groundHeight(0, 4.9)).toBeGreaterThan(0);
    expect(groundHeight(0, 4.9)).toBeLessThan(SIDEWALK_H);
  });
});
