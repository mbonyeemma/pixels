import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountView, ServerMessage } from '../types';

/* A scripted WebSocket + fetch + localStorage so the real client runs without a server. */
class FakeWS {
  static OPEN = 1;
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close(code = 1000) {
    this.readyState = 3;
    const h = this.onclose;
    this.onclose = null;
    h?.({ code });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(m: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const acct: AccountView = { id: 'me', username: 'me', tag: '0001', displayName: 'me#0001', email: 'm@x.io', coins: 100, inventory: {}, equipped: {} };
const welcome = (): ServerMessage => ({ t: 'welcome', you: acct, players: [], worldTime: 0.2, serverTime: Date.now(), mission: null, position: { x: 1, z: 2, ry: 0 } });
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

let store: Map<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;

async function boot() {
  vi.resetModules();
  const state = await import('../state');
  const client = await import('../net/client');
  const extras = await import('../net/extras');
  return { ...state, ...client, ...extras };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWS.instances = [];
  store = new Map();
  fetchMock = vi.fn();
  vi.stubGlobal('WebSocket', FakeWS);
  vi.stubGlobal('window', { location: { protocol: 'http:', host: 'localhost:5173' } });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const lastWs = () => FakeWS.instances.at(-1)!;

describe('login', () => {
  it('rejects invalid input locally without a request', async () => {
    const { gameClient, useGame } = await boot();
    await gameClient.login('a', 'nope');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useGame.getState().loginError).toBeTruthy();
  });

  it('surfaces server errors and keeps the user on the login screen', async () => {
    const { gameClient, useGame } = await boot();
    fetchMock.mockResolvedValueOnce(json(409, { error: 'That username belongs to another email.' }));
    await gameClient.login('amy', 'amy@x.io');
    expect(useGame.getState().loginError).toBe('That username belongs to another email.');
    expect(useGame.getState().account).toBeNull();
    expect(useGame.getState().loading).toBe(false);
    expect(store.has('pixels.token')).toBe(false);
  });

  it('handles an unreachable server', async () => {
    const { gameClient, useGame } = await boot();
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await gameClient.login('amy', 'amy@x.io');
    expect(useGame.getState().loginError).toMatch(/can't reach/i);
  });

  it('stores the token, connects with it, and applies welcome', async () => {
    const { gameClient, useGame, runtime } = await boot();
    fetchMock.mockResolvedValueOnce(json(200, { token: 'tok123', account: acct }));
    await gameClient.login(' amy ', 'amy@x.io');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ username: 'amy', email: 'amy@x.io' });
    expect(store.get('pixels.token')).toBe('tok123');
    expect(useGame.getState()).toMatchObject({ token: 'tok123', status: 'connecting' });
    expect(lastWs().url).toBe('ws://localhost:5173/ws?token=tok123');
    lastWs().open();
    expect(lastWs().sent[0]).toMatchObject({ t: 'ping' });
    lastWs().receive(welcome());
    expect(useGame.getState()).toMatchObject({ status: 'connected', selfId: 'me' });
    expect(runtime.local).toMatchObject({ x: 1, z: 2 });
  });
});

describe('resume', () => {
  it('returns false without a token', async () => {
    const { gameClient } = await boot();
    expect(await gameClient.resume()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('restores the session from /api/me (bare AccountView) and connects', async () => {
    store.set('pixels.token', 'tok');
    const { gameClient, useGame } = await boot();
    fetchMock.mockResolvedValueOnce(json(200, acct));
    expect(await gameClient.resume()).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    expect(useGame.getState().account?.id).toBe('me');
    expect(lastWs().url).toContain('token=tok');
  });
  it('clears the token on 401', async () => {
    store.set('pixels.token', 'stale');
    const { gameClient, useGame } = await boot();
    fetchMock.mockResolvedValueOnce(json(401, { error: 'Not signed in.', code: 'unauthorized' }));
    expect(await gameClient.resume()).toBe(false);
    expect(store.has('pixels.token')).toBe(false);
    expect(useGame.getState().account).toBeNull();
  });
  it('keeps the token when the server is just unreachable', async () => {
    store.set('pixels.token', 'tok');
    const { gameClient, useGame } = await boot();
    fetchMock.mockRejectedValueOnce(new TypeError('down'));
    expect(await gameClient.resume()).toBe(false);
    expect(store.get('pixels.token')).toBe('tok');
    expect(useGame.getState().loginError).toMatch(/can't reach/i);
  });
});

async function connected() {
  const ctx = await boot();
  fetchMock.mockResolvedValueOnce(json(200, { token: 'tok', account: acct }));
  await ctx.gameClient.login('amy', 'amy@x.io');
  lastWs().open();
  lastWs().receive(welcome());
  return ctx;
}

describe('connection lifecycle', () => {
  it('reconnects with backoff after a drop and recovers', async () => {
    const { useGame, useExtras } = await connected();
    const first = lastWs();
    first.drop(1006);
    expect(useGame.getState().status).toBe('reconnecting');
    expect(useExtras.getState().retryAt).toBeGreaterThan(Date.now());
    expect(FakeWS.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(700);
    expect(FakeWS.instances).toHaveLength(2);
    lastWs().open();
    lastWs().receive(welcome());
    expect(useGame.getState().status).toBe('connected');
    expect(useExtras.getState().attempt).toBe(0);
  });

  it('keeps backing off while the server stays down (and checks the token)', async () => {
    const { useGame } = await connected();
    fetchMock.mockRejectedValue(new TypeError('down'));
    lastWs().drop(1006);
    await vi.advanceTimersByTimeAsync(700);
    expect(FakeWS.instances).toHaveLength(2);
    lastWs().drop(1006); // never welcomed -> verifySession (network error => unknown) then retry
    await vi.advanceTimersByTimeAsync(1500);
    expect(FakeWS.instances).toHaveLength(3);
    expect(useGame.getState().status).toBe('reconnecting');
  });

  it('does not reconnect after a kick', async () => {
    const { useGame, useExtras } = await connected();
    lastWs().receive({ t: 'kicked', reason: 'You signed in from another place.' });
    expect(useGame.getState()).toMatchObject({ status: 'disconnected', statusDetail: 'You signed in from another place.' });
    expect(useExtras.getState().kicked).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWS.instances).toHaveLength(1);
    expect(useGame.getState().status).toBe('disconnected');
  });

  it('treats close code 4003 (kicked) as terminal even without a kicked message', async () => {
    const { useGame } = await connected();
    lastWs().drop(4003);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeWS.instances).toHaveLength(1);
    expect(useGame.getState().status).toBe('disconnected');
  });

  it('returns to the login screen when the token is rejected', async () => {
    const { useGame } = await connected();
    lastWs().drop(4001);
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeWS.instances).toHaveLength(1);
    expect(useGame.getState()).toMatchObject({ token: null, account: null, status: 'idle' });
    expect(useGame.getState().loginError).toMatch(/expired|sign in/i);
    expect(store.has('pixels.token')).toBe(false);
  });

  it('verifies the token via /api/me when a connection never gets going', async () => {
    const { useGame } = await connected();
    lastWs().drop(1006);
    await vi.advanceTimersByTimeAsync(700);
    fetchMock.mockResolvedValueOnce(json(401, { error: 'Not signed in.' }));
    lastWs().drop(1006); // dies before welcome
    await vi.advanceTimersByTimeAsync(50);
    expect(useGame.getState().account).toBeNull();
    expect(useGame.getState().loginError).toBeTruthy();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWS.instances).toHaveLength(2);
  });

  it('sends a heartbeat ping every 5 seconds', async () => {
    await connected();
    const ws = lastWs();
    const pings = () => ws.sent.filter((m) => m.t === 'ping').length;
    const before = pings();
    await vi.advanceTimersByTimeAsync(5000);
    expect(pings()).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(pings()).toBe(before + 2);
  });

  it('declares a silent connection dead and reconnects', async () => {
    const { useGame } = await connected();
    await vi.advanceTimersByTimeAsync(26_000); // no inbound traffic at all
    expect(useGame.getState().status).toBe('reconnecting');
  });

  it('logout closes the socket and resets the store', async () => {
    const { gameClient, useGame } = await connected();
    gameClient.logout();
    expect(useGame.getState()).toMatchObject({ token: null, account: null, status: 'idle', selfId: null });
    expect(store.has('pixels.token')).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeWS.instances).toHaveLength(1);
  });
});

describe('outbound messages', () => {
  it('validates and rate-limits chat', async () => {
    const { gameClient, useGame } = await connected();
    const ws = lastWs();
    const chats = () => ws.sent.filter((m) => m.t === 'chat');
    gameClient.sendChat('   ');
    expect(chats()).toHaveLength(0);
    gameClient.sendChat('  hello ‮ world ');
    expect(chats()).toEqual([{ t: 'chat', text: 'hello world' }]);
    gameClient.sendChat('two');
    gameClient.sendChat('three');
    gameClient.sendChat('four'); // 4th inside the window
    expect(chats()).toHaveLength(3);
    expect(useGame.getState().toasts.at(-1)!.text).toMatch(/too fast/i);
    await vi.advanceTimersByTimeAsync(4000);
    gameClient.sendChat('later');
    expect(chats()).toHaveLength(4);
  });

  it('validates buy / equip / mission requests on the client', async () => {
    const { gameClient, useGame } = await connected();
    const ws = lastWs();
    const sent = (t: string) => ws.sent.filter((m) => m.t === t);
    gameClient.buy('nonsense');
    gameClient.buy('explorer_badge'); // not for sale
    expect(sent('shop_buy')).toHaveLength(0);
    useGame.setState({ account: { ...acct, coins: 3 } });
    gameClient.buy('coffee');
    expect(sent('shop_buy')).toHaveLength(0);
    expect(useGame.getState().toasts.at(-1)!.text).toMatch(/not enough coins/i);
    useGame.setState({ account: { ...acct, coins: 50 } });
    gameClient.buy('coffee');
    expect(sent('shop_buy')).toEqual([{ t: 'shop_buy', itemId: 'coffee' }]);

    gameClient.equip('hat', 'explorer_cap'); // not owned
    gameClient.equip('hat', 'neon_sneakers'); // wrong slot
    expect(sent('equip')).toHaveLength(0);
    useGame.setState({ account: { ...acct, inventory: { explorer_cap: 1 } } });
    await vi.advanceTimersByTimeAsync(400);
    gameClient.equip('hat', 'explorer_cap');
    expect(sent('equip')).toEqual([{ t: 'equip', slot: 'hat', itemId: 'explorer_cap' }]);

    gameClient.abandonMission(); // none active
    expect(sent('mission_abandon')).toHaveLength(0);
    gameClient.acceptMission('offer-1');
    expect(sent('mission_accept')).toEqual([{ t: 'mission_accept', offerId: 'offer-1' }]);
    useGame.setState({ mission: { id: 'm' } as never });
    await vi.advanceTimersByTimeAsync(700);
    gameClient.acceptMission('offer-2'); // already on a mission
    expect(sent('mission_accept')).toHaveLength(1);
  });

  it('throttles moves to ~15 Hz with latest-wins and drops non-finite values', async () => {
    const { gameClient } = await connected();
    const ws = lastWs();
    const moves = () => ws.sent.filter((m) => m.t === 'move');
    await vi.advanceTimersByTimeAsync(200);
    gameClient.sendMove(1, 1, 0, 'walk', 1);
    expect(moves()).toHaveLength(1);
    gameClient.sendMove(2, 1, 0, 'walk', 2); // too soon: queued
    gameClient.sendMove(3, 1, 0, 'idle', 3); // replaces the queued one
    expect(moves()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(80);
    expect(moves()).toHaveLength(2);
    expect(moves()[1]).toMatchObject({ x: 3, anim: 'idle', seq: 3 });
    gameClient.sendMove(NaN, 0, 0, 'idle', 4);
    // @ts-expect-error invalid anim
    gameClient.sendMove(0, 0, 0, 'fly', 5);
    await vi.advanceTimersByTimeAsync(200);
    expect(moves()).toHaveLength(2);
  });

  it('does nothing harmful while disconnected', async () => {
    const { gameClient, useGame } = await boot();
    gameClient.sendMove(1, 1, 0, 'idle', 1);
    gameClient.sendChat('hi');
    gameClient.interact('shop_counter');
    expect(FakeWS.instances).toHaveLength(0);
    expect(useGame.getState().toasts.at(-1)!.text).toMatch(/not connected/i);
  });
});

describe('askAi', () => {
  const aiOk = (actions: unknown[] = []) => ({
    reply: 'The shop is north of the plaza.', interpretation: 'You asked where the shop is.', plan: ['Look up the shop'], actions, provider: 'rules', usage: { remainingToday: 19, limitPerDay: 20 },
  });

  it('posts with the bearer token, appends lines, and auto-executes navigation', async () => {
    const { gameClient, useGame, runtime, useExtras } = await connected();
    Object.assign(runtime.local, { x: 1.5, z: 14 });
    fetchMock.mockResolvedValueOnce(json(200, aiOk([{ type: 'navigate', locationId: 'shop', label: 'Pixel Market', x: 20, z: -8, distance: 31 }])));
    await gameClient.askAi('  Take me to the shop ');
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe('/api/ai');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ message: 'Take me to the shop' });
    const ai = useGame.getState().ai;
    expect(ai.map((l) => l.from)).toEqual(['you', 'ai']);
    expect(ai[1]).toMatchObject({ text: 'The shop is north of the plaza.', interpretation: 'You asked where the shop is.', plan: ['Look up the shop'] });
    expect(runtime.navPath?.locationId).toBe('shop');
    expect(useGame.getState().aiBusy).toBe(false);
    expect(useExtras.getState().aiUsage).toEqual({ remainingToday: 19, limitPerDay: 20 });
  });

  it('opens the shop and records mission offers, but never buys on its own', async () => {
    const { gameClient, useGame } = await connected();
    const offer = { offerId: 'o9', title: 'Parcel run', description: 'd', type: 'delivery', estimatedMinutes: 3, objectives: ['a', 'b'], reward: { label: '40 coins (mock in-game reward)', mock: true }, expiresAt: Date.now() + 60_000 };
    fetchMock.mockResolvedValueOnce(json(200, aiOk([{ type: 'open_shop' }, { type: 'mission_offer', offer }, { type: 'purchase_proposal', itemId: 'coffee', name: 'Pixel Coffee', price: 5, canAfford: true }])));
    useGame.setState({ panel: 'ai' });
    await gameClient.askAi('show me stuff');
    expect(useGame.getState().panel).toBe('shop');
    expect(useGame.getState().offers.map((o) => o.offerId)).toEqual(['o9']);
    expect(lastWs().sent.some((m) => m.t === 'shop_buy')).toBe(false);
  });

  it('maps API error codes to friendly lines and keeps the game usable', async () => {
    const { gameClient, useGame } = await connected();
    fetchMock.mockResolvedValueOnce(json(429, { error: 'Too many requests.', code: 'rate_limited', retryAfterSec: 4 }));
    await gameClient.askAi('hello');
    expect(useGame.getState().ai.at(-1)).toMatchObject({ from: 'ai', error: true });
    expect(useGame.getState().ai.at(-1)!.text).toContain('4s');
    fetchMock.mockResolvedValueOnce(json(503, { error: 'x', code: 'unavailable' }));
    await gameClient.askAi('hello again');
    expect(useGame.getState().ai.at(-1)!.text).toMatch(/unavailable/i);
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    await gameClient.askAi('third');
    expect(useGame.getState().ai.at(-1)).toMatchObject({ error: true });
    expect(useGame.getState().aiBusy).toBe(false);
    expect(useGame.getState().token).toBe('tok');
  });

  it('times out after 30 seconds', async () => {
    const { gameClient, useGame } = await connected();
    fetchMock.mockImplementationOnce((_u: string, init: { signal: AbortSignal }) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
    const p = gameClient.askAi('slow one');
    expect(useGame.getState().aiBusy).toBe(true);
    await vi.advanceTimersByTimeAsync(30_001);
    await p;
    expect(useGame.getState().ai.at(-1)!.text).toMatch(/too long/i);
    expect(useGame.getState().aiBusy).toBe(false);
  });

  it('refuses concurrent and over-long questions', async () => {
    const { gameClient, useGame } = await connected();
    await gameClient.askAi('x'.repeat(301));
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the login call
    expect(useGame.getState().ai.at(-1)).toMatchObject({ error: true });
    let release: (v: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (release = r)));
    const first = gameClient.askAi('one');
    await gameClient.askAi('two'); // ignored: busy
    expect(fetchMock).toHaveBeenCalledTimes(2);
    release(json(200, aiOk()));
    await first;
    expect(useGame.getState().ai.filter((l) => l.from === 'you').map((l) => l.text)).toEqual(['one']);
  });
});
