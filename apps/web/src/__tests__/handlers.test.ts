import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountView, MissionStateView, PlayerView, ServerMessage } from '../types';
import { runtime, useGame } from '../state';
import { BUBBLE_SECONDS, BUFFER_CAP, MAX_CHAT_LINES, handleServerMessage, resetSessionState, type HandlerEnv } from '../net/handlers';
import { useExtras } from '../net/extras';

const env: HandlerEnv = { perfNow: () => 5000, dateNow: () => 1_000_000 };

const account = (over: Partial<AccountView> = {}): AccountView => ({
  id: 'me', username: 'me', tag: '0001', displayName: 'me#0001', email: 'me@x.io', coins: 100, inventory: {}, equipped: {}, ...over,
});
const pv = (id: string, over: Partial<PlayerView> = {}): PlayerView => ({ id, name: `${id}#0002`, x: 1, z: 2, ry: 0.5, anim: 'idle', equipped: {}, ...over });
const mission = (over: Partial<MissionStateView> = {}): MissionStateView => ({
  id: 'm1', type: 'visit_location', title: 'Visit the library', description: 'd', reward: { label: '15 coins (mock in-game reward)', coins: 15, mock: true },
  objectives: [{ id: 'o1', kind: 'goto', label: 'Go to the library', x: 22, z: 8, done: false }], current: 0, startedAt: 0, expiresAt: 2_000_000, ...over,
});

const welcome = (over: Partial<Extract<ServerMessage, { t: 'welcome' }>> = {}): ServerMessage => ({
  t: 'welcome', you: account(), players: [pv('me'), pv('bob')], worldTime: 0.4, serverTime: 1_000_500, mission: null, position: { x: 10, z: 20, ry: 1 }, ...over,
});

beforeEach(() => {
  resetSessionState();
  useGame.setState({ token: 't' });
  vi.useFakeTimers();
});

describe('welcome', () => {
  it('populates account, players, remotes (excluding self), position, clock and mission', () => {
    const onWelcome = vi.fn();
    handleServerMessage(welcome({ mission: mission() }), { onWelcome }, env);
    const st = useGame.getState();
    expect(st.selfId).toBe('me');
    expect(st.account?.displayName).toBe('me#0001');
    expect(Object.keys(st.players).sort()).toEqual(['bob', 'me']);
    expect([...runtime.remotes.keys()]).toEqual(['bob']);
    expect(runtime.remotes.get('bob')!.buffer).toHaveLength(1);
    expect(runtime.local).toMatchObject({ x: 10, z: 20, ry: 1 });
    expect(runtime.correction).toEqual({ x: 10, z: 20 });
    expect(runtime.serverOffsetMs).toBe(500);
    expect(st.status).toBe('connected');
    expect(st.clock).toBe(0.4);
    expect(st.mission?.title).toBe('Visit the library');
    expect(onWelcome).toHaveBeenCalledOnce();
  });
  it('rebuilds remotes on a re-welcome (reconnect)', () => {
    handleServerMessage(welcome(), {}, env);
    handleServerMessage(welcome({ players: [pv('me'), pv('carol')] }), {}, env);
    expect([...runtime.remotes.keys()]).toEqual(['carol']);
  });
  it('still finds self when the players list omits it', () => {
    handleServerMessage(welcome({ players: [pv('bob')] }), {}, env);
    expect(useGame.getState().players.me.name).toBe('me#0001');
    expect(runtime.remotes.has('me')).toBe(false);
  });
});

describe('players and snapshots', () => {
  beforeEach(() => handleServerMessage(welcome(), {}, env));

  it('adds/removes players with system chat lines', () => {
    handleServerMessage({ t: 'player_join', player: pv('dan') }, {}, env);
    expect(runtime.remotes.has('dan')).toBe(true);
    expect(useGame.getState().players.dan.name).toBe('dan#0002');
    expect(useGame.getState().chat.at(-1)).toMatchObject({ system: true, text: 'dan#0002 joined the town' });
    handleServerMessage({ t: 'player_leave', id: 'dan' }, {}, env);
    expect(runtime.remotes.has('dan')).toBe(false);
    expect(useGame.getState().players.dan).toBeUndefined();
    expect(useGame.getState().chat.at(-1)).toMatchObject({ system: true, text: 'dan#0002 left the town' });
  });

  it('pushes snapshots to remotes with local time, skips self and unknown ids, caps the buffer', () => {
    handleServerMessage({ t: 'snap', time: 1, players: [{ id: 'me', x: 9, z: 9, ry: 0, anim: 'run' }, { id: 'ghost', x: 1, z: 1, ry: 0, anim: 'idle' }, { id: 'bob', x: 3, z: 4, ry: 2, anim: 'walk' }] }, {}, env);
    const bob = runtime.remotes.get('bob')!;
    expect(bob.buffer.at(-1)).toEqual({ t: 5, x: 3, z: 4, ry: 2, anim: 'walk' });
    expect(runtime.remotes.has('ghost')).toBe(false);
    expect(runtime.remotes.has('me')).toBe(false);
    for (let i = 0; i < 50; i++) handleServerMessage({ t: 'snap', time: i, players: [{ id: 'bob', x: i, z: 0, ry: 0, anim: 'walk' }] }, {}, env);
    expect(bob.buffer).toHaveLength(BUFFER_CAP);
    expect(bob.buffer.at(-1)!.x).toBe(49);
  });

  it('applies server corrections', () => {
    handleServerMessage({ t: 'correct', x: 1.5, z: -2, seq: 3 }, {}, env);
    expect(runtime.correction).toEqual({ x: 1.5, z: -2 });
  });
});

describe('chat', () => {
  beforeEach(() => handleServerMessage(welcome(), {}, env));

  it('appends sanitised lines and sets a bubble using performance.now()/1000', () => {
    handleServerMessage({ t: 'chat', id: 'bob', name: 'bob#0002', text: '  hello‮   world ', time: 7 }, {}, env);
    expect(useGame.getState().chat.at(-1)).toMatchObject({ playerId: 'bob', name: 'bob#0002', text: 'hello world', time: 7 });
    expect(runtime.remotes.get('bob')!.chatBubble).toEqual({ text: 'hello world', until: 5 + BUBBLE_SECONDS });
  });
  it('ignores empty messages and finds remotes by name as a fallback', () => {
    handleServerMessage({ t: 'chat', id: 'bob', name: 'bob#0002', text: '​  ', time: 1 }, {}, env);
    expect(useGame.getState().chat).toHaveLength(0);
    handleServerMessage({ t: 'chat', id: 'other-id', name: 'bob#0002', text: 'hi', time: 1 }, {}, env);
    expect(runtime.remotes.get('bob')!.chatBubble?.text).toBe('hi');
  });
  it('keeps at most 100 lines', () => {
    for (let i = 0; i < MAX_CHAT_LINES + 25; i++) handleServerMessage({ t: 'chat', id: 'bob', name: 'bob#0002', text: `m${i}`, time: i }, {}, env);
    const chat = useGame.getState().chat;
    expect(chat).toHaveLength(MAX_CHAT_LINES);
    expect(chat.at(-1)!.text).toBe(`m${MAX_CHAT_LINES + 24}`);
    expect(new Set(chat.map((c) => c.id)).size).toBe(MAX_CHAT_LINES);
  });
});

describe('appearance and account', () => {
  beforeEach(() => handleServerMessage(welcome(), {}, env));

  it('updates remote and own appearance', () => {
    handleServerMessage({ t: 'appearance', id: 'bob', equipped: { hat: 'explorer_cap' } }, {}, env);
    expect(runtime.remotes.get('bob')!.equipped).toEqual({ hat: 'explorer_cap' });
    expect(useGame.getState().players.bob.equipped.hat).toBe('explorer_cap');
    handleServerMessage({ t: 'appearance', id: 'me', equipped: { shoes: 'neon_sneakers' } }, {}, env);
    expect(useGame.getState().account!.equipped).toEqual({ shoes: 'neon_sneakers' });
    expect(useGame.getState().players.me.equipped).toEqual({ shoes: 'neon_sneakers' });
  });
  it('applies account updates', () => {
    handleServerMessage({ t: 'account', coins: 55, inventory: { coffee: 2 }, equipped: { hat: 'explorer_cap' } }, {}, env);
    expect(useGame.getState().account).toMatchObject({ coins: 55, inventory: { coffee: 2 }, equipped: { hat: 'explorer_cap' } });
    expect(useGame.getState().players.me.equipped).toEqual({ hat: 'explorer_cap' });
  });
  it('toasts shop results and syncs coins', () => {
    handleServerMessage({ t: 'shop_result', ok: true, itemId: 'coffee', message: 'Bought Pixel Coffee.', coins: 95 }, {}, env);
    expect(useGame.getState().account!.coins).toBe(95);
    expect(useGame.getState().toasts.at(-1)).toMatchObject({ level: 'info', text: 'Bought Pixel Coffee.' });
    handleServerMessage({ t: 'shop_result', ok: false, itemId: 'x', message: 'Not enough coins.', coins: 95 }, {}, env);
    expect(useGame.getState().toasts.at(-1)).toMatchObject({ level: 'warn', text: 'Not enough coins.' });
  });
});

describe('missions', () => {
  beforeEach(() => handleServerMessage(welcome(), {}, env));
  const offer = { offerId: 'o1', title: 'Visit the library', description: 'd', type: 'visit_location' as const, estimatedMinutes: 2, objectives: ['x'], reward: { label: 'r', mock: true as const }, expiresAt: 9_999_999 };

  it('stores state, clears the accepted offer and toasts', () => {
    useGame.setState({ offers: [offer, { ...offer, offerId: 'o2', title: 'Other', expiresAt: 9_999_999 }] });
    handleServerMessage({ t: 'mission', event: 'accepted', message: 'Mission accepted!', state: mission() }, {}, env);
    expect(useGame.getState().mission?.id).toBe('m1');
    expect(useGame.getState().offers.map((o) => o.offerId)).toEqual(['o2']);
    expect(useGame.getState().toasts.at(-1)!.text).toBe('Mission accepted!');
  });
  it('drops expired offers', () => {
    useGame.setState({ offers: [{ ...offer, expiresAt: 10 }] });
    handleServerMessage({ t: 'mission', event: 'progress', message: 'Nice', state: mission() }, {}, env);
    expect(useGame.getState().offers).toHaveLength(0);
  });
  it('celebrates completion with the reward label and a mock disclaimer', () => {
    useGame.setState({ mission: mission() });
    handleServerMessage({ t: 'mission', event: 'completed', message: 'done', state: null, reward: { label: '15 coins (mock in-game reward)', coins: 15, mock: true } }, {}, env);
    expect(useGame.getState().mission).toBeNull();
    const t = useGame.getState().toasts.at(-1)!.text;
    expect(t).toContain('Mission complete: Visit the library!');
    expect(t).toContain('15 coins (mock in-game reward)');
    useGame.setState({ mission: mission() });
    handleServerMessage({ t: 'mission', event: 'completed', message: 'done', state: null, reward: { label: '15 coins', mock: true } }, {}, env);
    expect(useGame.getState().toasts.at(-1)!.text).toContain('(mock in-game reward, no real-world value)');
  });
  it('keeps the active mission when a rejection carries no state', () => {
    useGame.setState({ mission: mission() });
    handleServerMessage({ t: 'mission', event: 'rejected', message: 'Already on a mission', state: null }, {}, env);
    expect(useGame.getState().mission?.id).toBe('m1');
    expect(useGame.getState().toasts.at(-1)).toMatchObject({ level: 'warn' });
    handleServerMessage({ t: 'mission', event: 'abandoned', message: 'Abandoned', state: null }, {}, env);
    expect(useGame.getState().mission).toBeNull();
  });
});

describe('toast / error / kicked / pong', () => {
  beforeEach(() => handleServerMessage(welcome(), {}, env));

  it('shows server toasts and errors', () => {
    handleServerMessage({ t: 'toast', level: 'warn', text: 'Careful' }, {}, env);
    expect(useGame.getState().toasts.at(-1)).toMatchObject({ level: 'warn', text: 'Careful' });
    handleServerMessage({ t: 'error', code: 'internal', message: 'Oops' }, {}, env);
    expect(useGame.getState().toasts.at(-1)).toMatchObject({ level: 'error', text: 'Oops' });
    handleServerMessage({ t: 'error', code: 'rate_limited', message: 'Slow down' }, {}, env);
    expect(useGame.getState().toasts.at(-1)).toMatchObject({ level: 'warn' });
  });
  it('routes auth errors to the hook instead of a toast', () => {
    const onAuthError = vi.fn();
    const n = useGame.getState().toasts.length;
    handleServerMessage({ t: 'error', code: 'unauthorized', message: 'Bad token' }, { onAuthError }, env);
    expect(onAuthError).toHaveBeenCalledWith('Bad token');
    expect(useGame.getState().toasts).toHaveLength(n);
  });
  it('kicked: disconnects with the reason and notifies the owner (no reconnect)', () => {
    const onKicked = vi.fn();
    handleServerMessage({ t: 'kicked', reason: 'You signed in from another place.' }, { onKicked }, env);
    expect(useGame.getState().status).toBe('disconnected');
    expect(useGame.getState().statusDetail).toBe('You signed in from another place.');
    expect(useExtras.getState().kicked).toBe(true);
    expect(onKicked).toHaveBeenCalledOnce();
  });
  it('abuse errors end the session the same way', () => {
    const onKicked = vi.fn();
    handleServerMessage({ t: 'error', code: 'abuse', message: 'Too many invalid messages' }, { onKicked }, env);
    expect(useGame.getState().status).toBe('disconnected');
    expect(onKicked).toHaveBeenCalled();
  });
  it('pong updates RTT and the server clock offset', () => {
    // client sent at 999_900, now is 1_000_000 (rtt 100); server says 1_000_050 => offset = 1_000_050 - 999_950 = 100
    handleServerMessage({ t: 'pong', c: 999_900, serverTime: 1_000_050 }, {}, env);
    expect(runtime.serverOffsetMs).toBe(100);
    expect(useGame.getState().statusDetail).toBe('100 ms');
    const before = runtime.serverOffsetMs;
    handleServerMessage({ t: 'pong', c: 1, serverTime: 5 }, {}, env); // absurd echo is ignored
    expect(runtime.serverOffsetMs).toBe(before);
  });
});

describe('resetSessionState', () => {
  it('clears everything session related but keeps preferences', () => {
    handleServerMessage(welcome(), {}, env);
    useGame.setState({ quality: 'low', panel: 'shop', typing: true });
    resetSessionState();
    const st = useGame.getState();
    expect(st).toMatchObject({ token: null, account: null, selfId: null, panel: 'none', typing: false, status: 'idle', quality: 'low' });
    expect(runtime.remotes.size).toBe(0);
    expect(runtime.serverOffsetMs).toBe(0);
  });
});
