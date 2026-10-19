import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ARRIVE_RADIUS, SPAWN, locationById, pathLength } from '@pixels/shared';
import type { AiAction, AiErrorResponse, AiResponse, MissionOfferView } from '../types';
import { runtime, useGame } from '../state';
import { planNavigation, startNavigation, stopNavigation } from '../net/nav';
import { aiErrorMessage, executeAiActions, isAiError, isAiResponse, responseToLine, type AiActionDeps } from '../net/ai';
import { resetSessionState } from '../net/handlers';

beforeEach(() => {
  resetSessionState();
  vi.useFakeTimers();
  Object.assign(runtime.local, { x: SPAWN.x, z: SPAWN.z });
});

describe('navigateTo path creation', () => {
  it('plans a path to the shop that ends at the shop and avoids obstacles', () => {
    const plan = planNavigation({ x: SPAWN.x, z: SPAWN.z }, 'shop');
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.arrived) throw new Error('expected a route');
    const shop = locationById('shop')!;
    const last = plan.points.at(-1)!;
    expect(last).toEqual({ x: shop.x, z: shop.z });
    expect(plan.distance).toBeGreaterThan(20);
    expect(plan.distance).toBe(Math.round(pathLength({ x: SPAWN.x, z: SPAWN.z }, plan.points)));
    expect(plan.label).toBe('Pixel Market');
  });

  it('sets runtime.navPath and toasts', () => {
    const plan = startNavigation('library');
    expect(plan.ok).toBe(true);
    expect(runtime.navPath).toMatchObject({ locationId: 'library', label: 'Town Library' });
    expect(runtime.navPath!.points.length).toBeGreaterThan(0);
    expect(useGame.getState().toasts.at(-1)!.text).toMatch(/Walking to Town Library \(\d+ m\)/);
    stopNavigation();
    expect(runtime.navPath).toBeNull();
  });

  it('rejects unknown and hidden locations with a toast and no path', () => {
    for (const id of ['nope', 'ts_oak']) {
      runtime.navPath = null;
      const plan = startNavigation(id);
      expect(plan.ok).toBe(false);
      expect(runtime.navPath).toBeNull();
      expect(useGame.getState().toasts.at(-1)!.level).toBe('warn');
    }
  });

  it('reports arrival instead of walking when already there', () => {
    const shop = locationById('shop')!;
    Object.assign(runtime.local, { x: shop.x + 1, z: shop.z });
    expect(Math.hypot(1, 0)).toBeLessThan(ARRIVE_RADIUS);
    const plan = startNavigation('shop');
    expect(plan).toMatchObject({ ok: true, arrived: true });
    expect(runtime.navPath).toBeNull();
    expect(useGame.getState().toasts.at(-1)!.text).toMatch(/already at/i);
  });
});

describe('AI responses', () => {
  const offer: MissionOfferView = { offerId: 'o1', title: 'Go', description: 'd', type: 'visit_location', estimatedMinutes: 2, objectives: ['a'], reward: { label: 'r', mock: true }, expiresAt: 1 };
  const makeDeps = () => {
    const deps = {
      navigateTo: vi.fn(),
      setPanel: vi.fn(),
      getPanel: vi.fn(() => 'ai' as const),
      setReturnPanel: vi.fn(),
      addOffer: vi.fn(),
      notify: vi.fn(),
    } satisfies AiActionDeps;
    return deps;
  };

  it('auto-executes only navigation, open_shop and offers; never a purchase', () => {
    const deps = makeDeps();
    const actions: AiAction[] = [
      { type: 'navigate', locationId: 'shop', label: 'Pixel Market', x: 20, z: -8, distance: 30 },
      { type: 'navigate', locationId: 'library', label: 'Library', x: 22, z: 8, distance: 10 },
      { type: 'open_shop' },
      { type: 'mission_offer', offer },
      { type: 'purchase_proposal', itemId: 'coffee', name: 'Pixel Coffee', price: 5, canAfford: true },
      { type: 'show_items', items: [] },
      { type: 'players', players: [] },
      { type: 'locations', locations: [] },
    ];
    executeAiActions(actions, deps);
    expect(deps.navigateTo).toHaveBeenCalledTimes(1);
    expect(deps.navigateTo).toHaveBeenCalledWith('shop');
    expect(deps.setReturnPanel).toHaveBeenCalledWith('ai');
    expect(deps.setPanel).toHaveBeenCalledWith('shop');
    expect(deps.addOffer).toHaveBeenCalledWith(offer);
    expect(deps.notify).toHaveBeenCalledOnce();
  });

  it('does nothing for render-only actions', () => {
    const deps = makeDeps();
    executeAiActions([{ type: 'purchase_proposal', itemId: 'coffee', name: 'Pixel Coffee', price: 5, canAfford: true }, { type: 'players', players: [{ name: 'a', distance: 1 }] }], deps);
    expect(deps.navigateTo).not.toHaveBeenCalled();
    expect(deps.setPanel).not.toHaveBeenCalled();
    expect(deps.addOffer).not.toHaveBeenCalled();
  });

  it('builds an ai line with interpretation, plan and actions', () => {
    const res: AiResponse = {
      reply: 'Sure!', interpretation: 'You want the shop', plan: ['Find the shop', 'Walk there'],
      actions: [{ type: 'open_shop' }], provider: 'rules', usage: { remainingToday: 9, limitPerDay: 10 },
    };
    const line = responseToLine(res, 'x1');
    expect(line).toMatchObject({ id: 'x1', from: 'ai', text: 'Sure!', interpretation: 'You want the shop', plan: ['Find the shop', 'Walk there'], provider: 'rules' });
    expect(line.actions).toHaveLength(1);
    expect(responseToLine({ ...res, plan: [], interpretation: '' }).plan).toBeUndefined();
  });

  it('recognises response shapes', () => {
    expect(isAiError({ error: 'x', code: 'timeout' })).toBe(true);
    expect(isAiError({ reply: 'hi' })).toBe(false);
    expect(isAiResponse({ reply: 'hi' })).toBe(true);
    expect(isAiResponse(null)).toBe(false);
  });

  it('maps every error code to friendly text', () => {
    const codes: AiErrorResponse['code'][] = ['rate_limited', 'quota_exceeded', 'timeout', 'unavailable', 'bad_request', 'unauthorized'];
    const seen = new Set<string>();
    for (const code of codes) {
      const m = aiErrorMessage({ code, error: 'raw server text' });
      expect(m.length).toBeGreaterThan(10);
      seen.add(m);
    }
    expect(seen.size).toBe(codes.length);
    expect(aiErrorMessage({ code: 'rate_limited', error: 'x', retryAfterSec: 7.2 })).toContain('8s');
    expect(aiErrorMessage({ code: 'unavailable', error: 'x' })).toMatch(/still works|explore/i);
    expect(aiErrorMessage(null, 429)).toMatch(/fast/i);
    expect(aiErrorMessage(null, 500)).toMatch(/unavailable/i);
  });
});
