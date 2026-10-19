/**
 * Server-message handling, separated from the socket so it can be unit-tested. It mutates the shared
 * zustand store (`useGame`) and the high-frequency `runtime`, nothing else.
 *
 * Time conventions (the 3D layer relies on these):
 *  - remote snapshot buffers use t = performance.now()/1000 at receipt
 *  - remote.chatBubble.until = performance.now()/1000 + BUBBLE_SECONDS
 */
import { runtime, useGame, type ChatLine, type PlayerInfo, type RemoteRuntime } from '../state';
import type { PlayerView, ServerMessage } from '../types';
import { ClockSync } from './clocksync';
import { sanitizeChat, sanitizeName } from './sanitize';
import { resetExtras, useExtras } from './extras';

export const BUFFER_CAP = 20;
export const BUBBLE_SECONDS = 6;
export const MAX_CHAT_LINES = 100;

export interface HandlerEnv {
  /** performance.now() in ms */
  perfNow: () => number;
  /** Date.now() in ms */
  dateNow: () => number;
}

const defaultEnv: HandlerEnv = { perfNow: () => performance.now(), dateNow: () => Date.now() };

export interface HandlerHooks {
  /** the server kicked us: the socket owner must not reconnect */
  onKicked?: (reason: string) => void;
  /** the server rejected our credentials */
  onAuthError?: (message: string) => void;
  /** first welcome of a (re)connection has been applied */
  onWelcome?: () => void;
}

export const clockSync = new ClockSync();

let lineSeq = 1;
const lineId = (prefix: string) => `${prefix}${Date.now().toString(36)}-${lineSeq++}`;

const AUTH_ERROR_CODES = new Set(['unauthorized', 'invalid_token', 'auth', 'auth_failed', 'token_expired', 'session_expired', 'unauthenticated']);

function pushChat(line: ChatLine): void {
  const { chat } = useGame.getState();
  const next = chat.length >= MAX_CHAT_LINES ? [...chat.slice(chat.length - MAX_CHAT_LINES + 1), line] : [...chat, line];
  useGame.setState({ chat: next });
}

function systemLine(text: string, env: HandlerEnv): void {
  pushChat({ id: lineId('s'), playerId: '', name: '', text, time: env.dateNow() + runtime.serverOffsetMs, system: true });
}

function makeRemote(p: PlayerView, env: HandlerEnv): RemoteRuntime {
  const t = env.perfNow() / 1000;
  return {
    id: p.id,
    name: sanitizeName(p.name) || 'Player',
    equipped: p.equipped ?? {},
    buffer: [{ t, x: p.x, z: p.z, ry: p.ry, anim: p.anim }],
    x: p.x,
    z: p.z,
    ry: p.ry,
    anim: p.anim,
  };
}

const toInfo = (p: PlayerView): PlayerInfo => ({ id: p.id, name: sanitizeName(p.name) || 'Player', equipped: p.equipped ?? {} });

function remoteFor(id: string, name?: string): RemoteRuntime | undefined {
  const byId = runtime.remotes.get(id);
  if (byId) return byId;
  if (name) for (const r of runtime.remotes.values()) if (r.name === name) return r;
  return undefined;
}

function isMock(label: string): boolean {
  return /mock/i.test(label);
}

export function handleServerMessage(msg: ServerMessage, hooks: HandlerHooks = {}, env: HandlerEnv = defaultEnv): void {
  const st = useGame.getState();
  switch (msg.t) {
    case 'welcome': {
      const you = msg.you;
      let selfId = you.id;
      for (const p of msg.players) if (p.id === you.id || p.name === you.displayName) selfId = p.id;
      const players: Record<string, PlayerInfo> = {};
      runtime.remotes.clear();
      for (const p of msg.players) {
        if (p.id === selfId) continue;
        players[p.id] = toInfo(p);
        runtime.remotes.set(p.id, makeRemote(p, env));
      }
      players[selfId] = { id: selfId, name: you.displayName, equipped: you.equipped ?? {} };
      Object.assign(runtime.local, { x: msg.position.x, z: msg.position.z, ry: msg.position.ry, anim: 'idle', speed: 0 });
      runtime.correction = { x: msg.position.x, z: msg.position.z };
      clockSync.reset();
      runtime.serverOffsetMs = msg.serverTime - env.dateNow();
      useGame.setState({
        account: you,
        selfId,
        players,
        mission: msg.mission ?? null,
        clock: msg.worldTime,
        status: 'connected',
        statusDetail: '',
        loginError: null,
        loading: false,
      });
      useExtras.getState().patch({ attempt: 0, retryAt: null, kicked: false });
      hooks.onWelcome?.();
      return;
    }

    case 'player_join': {
      const p = msg.player;
      const info = toInfo(p);
      useGame.setState({ players: { ...st.players, [p.id]: info } });
      if (p.id === st.selfId) return;
      runtime.remotes.set(p.id, makeRemote(p, env));
      systemLine(`${info.name} joined the town`, env);
      return;
    }

    case 'player_leave': {
      const remote = runtime.remotes.get(msg.id);
      const name = st.players[msg.id]?.name ?? remote?.name;
      runtime.remotes.delete(msg.id);
      if (msg.id in st.players) {
        const players = { ...st.players };
        delete players[msg.id];
        useGame.setState({ players });
      }
      if (name && msg.id !== st.selfId) systemLine(`${name} left the town`, env);
      return;
    }

    case 'snap': {
      const t = env.perfNow() / 1000;
      for (const e of msg.players) {
        if (e.id === st.selfId) continue;
        const r = runtime.remotes.get(e.id);
        if (!r) continue;
        r.buffer.push({ t, x: e.x, z: e.z, ry: e.ry, anim: e.anim });
        if (r.buffer.length > BUFFER_CAP) r.buffer.splice(0, r.buffer.length - BUFFER_CAP);
      }
      return;
    }

    case 'correct':
      runtime.correction = { x: msg.x, z: msg.z };
      return;

    case 'chat': {
      const text = sanitizeChat(msg.text);
      if (!text) return;
      const name = sanitizeName(msg.name) || st.players[msg.id]?.name || 'Someone';
      pushChat({ id: lineId('c'), playerId: msg.id, name, text, time: msg.time });
      const r = remoteFor(msg.id, name);
      if (r) r.chatBubble = { text, until: env.perfNow() / 1000 + BUBBLE_SECONDS };
      return;
    }

    case 'appearance': {
      const equipped = msg.equipped ?? {};
      const cur = st.players[msg.id];
      const patch: Partial<ReturnType<typeof useGame.getState>> = {};
      if (cur) patch.players = { ...st.players, [msg.id]: { ...cur, equipped } };
      if (msg.id === st.selfId && st.account) patch.account = { ...st.account, equipped };
      if (Object.keys(patch).length) useGame.setState(patch);
      const r = runtime.remotes.get(msg.id);
      if (r) r.equipped = equipped;
      return;
    }

    case 'account': {
      if (!st.account) return;
      const account = { ...st.account, coins: msg.coins, inventory: msg.inventory, equipped: msg.equipped };
      const patch: Partial<ReturnType<typeof useGame.getState>> = { account };
      const me = st.selfId ? st.players[st.selfId] : undefined;
      if (me && st.selfId) patch.players = { ...st.players, [st.selfId]: { ...me, equipped: msg.equipped } };
      useGame.setState(patch);
      return;
    }

    case 'shop_result': {
      if (st.account && Number.isFinite(msg.coins)) useGame.setState({ account: { ...st.account, coins: msg.coins } });
      st.toast(msg.message || (msg.ok ? 'Purchase complete.' : 'Purchase failed.'), msg.ok ? 'info' : 'warn');
      return;
    }

    case 'mission': {
      const prev = st.mission;
      const mission = msg.event === 'rejected' && !msg.state ? prev : (msg.state ?? null);
      let offers = st.offers;
      const serverNow = env.dateNow() + runtime.serverOffsetMs;
      offers = offers.filter((o) => o.expiresAt > serverNow);
      if (msg.event === 'accepted') {
        const acc = msg.state ?? prev;
        if (acc) offers = offers.filter((o) => o.title !== acc.title);
      }
      useGame.setState({ mission, offers });
      if (msg.event === 'completed') {
        const title = prev?.title ?? msg.state?.title;
        const label = msg.reward?.label ?? prev?.reward.label ?? '';
        const reward = label ? ` Reward: ${label}${isMock(label) ? '' : ' (mock in-game reward, no real-world value)'}` : '';
        st.toast(`Mission complete${title ? `: ${title}` : ''}!${reward}`, 'info');
      } else if (msg.message) {
        st.toast(msg.message, msg.event === 'rejected' || msg.event === 'expired' ? 'warn' : 'info');
      }
      return;
    }

    case 'toast':
      st.toast(sanitizeChat(msg.text, 240), msg.level);
      return;

    case 'error': {
      const message = sanitizeChat(msg.message || msg.code || 'Something went wrong.', 240);
      if (AUTH_ERROR_CODES.has(String(msg.code))) {
        hooks.onAuthError?.(message);
        return;
      }
      if (msg.code === 'abuse') {
        // the server is about to close the socket for good: show why and do not auto-reconnect
        useExtras.getState().patch({ kicked: true, retryAt: null });
        useGame.setState({ status: 'disconnected', statusDetail: message });
        hooks.onKicked?.(message);
        return;
      }
      st.toast(message, /rate|limit|slow|cooldown/i.test(String(msg.code)) ? 'warn' : 'error');
      return;
    }

    case 'kicked': {
      const reason = sanitizeChat(msg.reason || 'You were disconnected by the server.', 240);
      useExtras.getState().patch({ kicked: true, retryAt: null });
      useGame.setState({ status: 'disconnected', statusDetail: reason });
      st.toast(reason, 'error');
      hooks.onKicked?.(reason);
      return;
    }

    case 'pong': {
      const received = env.dateNow();
      if (typeof msg.c !== 'number' || msg.c > received + 1000 || received - msg.c > 60_000) return;
      const { rtt, best } = clockSync.add(msg.c, msg.serverTime, received);
      runtime.serverOffsetMs = best.offset;
      if (st.status === 'connected') {
        const detail = `${Math.round(rtt)} ms`;
        if (st.statusDetail !== detail) useGame.setState({ statusDetail: detail });
      }
      return;
    }

    default:
      return;
  }
}

/** Clears all session-derived state (logout / auth failure). Leaves user preferences (quality) intact. */
export function resetSessionState(): void {
  runtime.remotes.clear();
  runtime.navPath = null;
  runtime.correction = null;
  runtime.emoteRequest = null;
  runtime.serverOffsetMs = 0;
  runtime.localMoveSeq = 0;
  Object.assign(runtime.local, { x: 0, z: 0, ry: 0, anim: 'idle', speed: 0 });
  clockSync.reset();
  resetExtras();
  useGame.setState({
    token: null,
    account: null,
    status: 'idle',
    statusDetail: '',
    loading: false,
    players: {},
    selfId: null,
    chat: [],
    mission: null,
    offers: [],
    toasts: [],
    nearPrompt: null,
    panel: 'none',
    typing: false,
    chatOpen: false,
    ai: [],
    aiBusy: false,
  });
}
