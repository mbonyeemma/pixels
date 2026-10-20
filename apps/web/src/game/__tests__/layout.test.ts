import { describe, expect, it } from 'vitest';
import { BUILDINGS, COLLIDERS, FOUNTAIN, POND, PROPS, SHOP_COUNTER, WORLD_BOUNDS } from '@pixels/shared';
import { isOpenGrass, PLAZA_RECT } from '../logic/layout';
import { STYLES, wallLayout } from '../gfx/facade';
import { outerHeight } from '../gfx/terrain';

describe('isOpenGrass', () => {
  it('rejects roads, sidewalks, plaza, buildings, pond and the world edge', () => {
    expect(isOpenGrass(0, 0)).toBe(false); // road
    expect(isOpenGrass(20, 7)).toBe(false); // sidewalk
    expect(isOpenGrass(1.5, 20)).toBe(false); // plaza
    expect(isOpenGrass(BUILDINGS[0].x, BUILDINGS[0].z)).toBe(false); // inside a building
    expect(isOpenGrass(POND.x, POND.z)).toBe(false);
    expect(isOpenGrass(WORLD_BOUNDS.maxX, 0)).toBe(false);
    expect(isOpenGrass(0, -40)).toBe(false); // park path
  });
  it('accepts open lawn', () => {
    expect(isOpenGrass(-14, -20)).toBe(true);
    expect(isOpenGrass(-40, 40)).toBe(true);
  });
  it('plaza paving covers the fountain and the spawn', () => {
    expect(FOUNTAIN.x).toBeGreaterThan(PLAZA_RECT.minX);
    expect(FOUNTAIN.x).toBeLessThan(PLAZA_RECT.maxX);
    expect(FOUNTAIN.z).toBeGreaterThan(PLAZA_RECT.minZ);
    expect(FOUNTAIN.z).toBeLessThan(PLAZA_RECT.maxZ);
  });
});

describe('world data sanity used by the renderer', () => {
  it('every building has a facade style and a sensible floor layout', () => {
    for (const b of BUILDINGS) {
      expect(STYLES[b.kind]).toBeTruthy();
      const L = wallLayout(b.kind, b.w, b.h);
      expect(L.floors).toBeGreaterThanOrEqual(1);
      expect(L.gfH + L.floors * L.floorH).toBeCloseTo(b.h, 5);
      expect(L.bays).toBeGreaterThanOrEqual(2);
      expect(L.winW).toBeLessThan(L.bayW);
      expect(L.winH).toBeLessThan(L.floorH);
    }
  });
  it('the shop counter stands in front of the market, between the kiosk walls', () => {
    const market = BUILDINGS.find((b) => b.kind === 'shop')!;
    expect(market.door).toBe('S');
    expect(SHOP_COUNTER.z).toBeGreaterThan(market.z + market.d / 2 - 0.01);
    expect(Math.abs(SHOP_COUNTER.x - market.x)).toBeLessThan(market.w / 2);
  });
  it('terrain is flat inside the town and rises outside', () => {
    expect(outerHeight(0, 0)).toBe(0);
    expect(outerHeight(55, -55)).toBe(0);
    expect(outerHeight(300, 0)).toBeGreaterThan(10);
  });
  it('every tree prop has a collider (rendering and collision stay consistent)', () => {
    const trees = PROPS.filter((p) => p.kind === 'tree');
    expect(trees.length).toBeGreaterThan(20);
    for (const t of trees) {
      expect(COLLIDERS.some((c) => c.kind === 'circle' && c.x === t.x && c.z === t.z)).toBe(true);
    }
  });
});
