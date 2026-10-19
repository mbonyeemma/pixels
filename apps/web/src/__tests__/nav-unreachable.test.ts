import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pixels/shared', async (orig) => ({ ...(await orig<typeof import('@pixels/shared')>()), findPath: () => null }));

import { runtime, useGame } from '../state';
import { startNavigation } from '../net/nav';
import { resetSessionState } from '../net/handlers';

describe('navigateTo when no route exists', () => {
  beforeEach(() => {
    resetSessionState();
    vi.useFakeTimers();
    Object.assign(runtime.local, { x: 1.5, z: 14 });
  });
  it('toasts a warning and leaves navPath unset', () => {
    const plan = startNavigation('shop');
    expect(plan).toMatchObject({ ok: false });
    expect(runtime.navPath).toBeNull();
    expect(useGame.getState().toasts.at(-1)).toMatchObject({ level: 'warn' });
    expect(useGame.getState().toasts.at(-1)!.text).toMatch(/walkable route/i);
  });
});
