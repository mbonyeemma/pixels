import { describe, expect, it } from 'vitest';
import { SHOP_COUNTER } from '@pixels/shared';
import type { MissionStateView } from '../../types';
import { objectiveTarget, pickInteractable, PROMPTS } from '../logic/interact';

const mission = (kind: 'goto' | 'pickup' | 'dropoff' | 'collect', x: number, z: number, id = 'bakery', done = false): MissionStateView => ({
  id: 'm1', type: 'delivery', title: 't', description: 'd', reward: { label: 'r', mock: true },
  objectives: [{ id, kind, label: 'l', x, z, done }], current: 0, startedAt: 0, expiresAt: 1,
});

describe('pickInteractable', () => {
  it('offers the shop near the counter', () => {
    const r = pickInteractable(SHOP_COUNTER.x, SHOP_COUNTER.z + 1.5, null);
    expect(r?.prompt).toBe(PROMPTS.shop);
    expect(r?.action).toEqual({ kind: 'shop' });
  });
  it('offers nothing far away', () => {
    expect(pickInteractable(0, 20, null)).toBeNull();
  });
  it('offers pickup / dropoff / collect near the objective with the id as target', () => {
    expect(pickInteractable(-30, -8, mission('pickup', -30, -8, 'bakery'))?.action).toEqual({ kind: 'interact', target: 'bakery' });
    expect(pickInteractable(0, 8, mission('dropoff', 0, 8, 'dropoff:cafe'))?.prompt).toBe(PROMPTS.dropoff);
    const c = pickInteractable(-28, -52, mission('collect', -28, -52, 'ts_oak'));
    expect(c?.prompt).toBe(PROMPTS.collect);
    expect(c?.action).toEqual({ kind: 'interact', target: 'ts_oak' });
  });
  it('never prompts for goto objectives, done objectives, or when out of range', () => {
    expect(pickInteractable(5, 5, mission('goto', 5, 5))).toBeNull();
    expect(pickInteractable(5, 5, mission('pickup', 5, 5, 'x', true))).toBeNull();
    expect(pickInteractable(50, 50, mission('pickup', 5, 5))).toBeNull();
  });
  it('picks the nearer of shop and objective', () => {
    const m = mission('dropoff', SHOP_COUNTER.x + 2.5, SHOP_COUNTER.z, 'shop');
    expect(pickInteractable(SHOP_COUNTER.x + 2.4, SHOP_COUNTER.z, m)?.action).toEqual({ kind: 'interact', target: 'shop' });
    expect(pickInteractable(SHOP_COUNTER.x, SHOP_COUNTER.z + 1, m)?.action).toEqual({ kind: 'shop' });
  });
  it('extracts the target after the last colon', () => {
    expect(objectiveTarget('pickup:bakery')).toBe('bakery');
    expect(objectiveTarget('a:b:ts_oak')).toBe('ts_oak');
    expect(objectiveTarget('plain')).toBe('plain');
  });
});
