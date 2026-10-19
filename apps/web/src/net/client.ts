/**
 * Network client: HTTP (login / session resume / AI) + the realtime WebSocket, exposed to the rest of the app
 * as `gameClient` (see GameClientApi in ../state.ts). The server is authoritative; client-side validation and
 * rate limiting here only avoid pointless traffic and give friendlier feedback.
 */
import { AI_MESSAGE_MAX_LENGTH, ANIMS, DAY_LENGTH_SEC, EQUIP_SLOTS, MOVE_SEND_HZ, itemById, worldTimeOfDay } from '@pixels/shared';
import type { Anim, ClientMessage, LoginResponse, ServerMessage } from '../types';
import { runtime, useGame, type AiLine, type GameClientApi } from '../state';
import { reconnectDelay } from './backoff';
import { aiErrorMessage, executeAiActions, isAiError, isAiResponse, nextAiId, responseToLine, AI_BUSY_TEXT } from './ai';
import { useExtras } from './extras';
import { handleServerMessage, resetSessionState, type HandlerHooks } from './handlers';
import { NETWORK_ERROR_TEXT, httpErrorText, readJson } from './http';
import { startNavigation } from './nav';
import { sanitizeChat } from './sanitize';
import { clearToken, loadToken, saveLastLogin, saveToken } from './storage';
import { apiUrl, wsUrl } from './urls';
import { validateLogin, isLoginValid } from './validation';

const HEARTBEAT_MS = 5000;
const DEAD_AFTER_MS = 20_000;
const AI_TIMEOUT_MS = 30_000;
const MOVE_MIN_INTERVAL_MS = (1000 / MOVE_SEND_HZ) * 0.8;
/** Close codes for a rejected token (server uses 4001; 1008/4401/4403 are common alternatives). */
const AUTH_CLOSE_CODES = new Set([1008, 4001, 4401, 4403]);
/** Close codes meaning the server ended our session on purpose: do not reconnect automatically (4003 kicked, 4004 abuse). */
const NO_RECONNECT_CLOSE_CODES = new Map<number, string>([
  [4003, 'You signed in from another place.'],
  [4004, 'You were disconnected for sending too many invalid messages.'],
]);

let socket: WebSocket | null = null;
let generation = 0;
let welcomedThisSocket = false;
let intentionalClose = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;
let lastRx = 0;
let attempt = 0;
let resumeInFlight: Promise<boolean> | null = null;

/* ----------------------------------------------------------------- rate limiting */

const lastAt = new Map<string, number>();
function allow(key: string, minMs: number): boolean {
  const now = performance.now();
  const prev = lastAt.get(key) ?? -Infinity;
  if (now - prev < minMs) return false;
  lastAt.set(key, now);
  return true;
}

/** Mirrors the server's chat limit (3 burst, then ~1 per 1.2 s) so we warn instead of being throttled. */
const chatTimes: number[] = [];
function chatAllowed(): boolean {
  const now = performance.now();
  while (chatTimes.length && now - chatTimes[0] > 3600) chatTimes.shift();
  if (chatTimes.length >= 3) return false;
  chatTimes.push(now);
  return true;
}

/* --------------------------------------------------------------------- sending */

function sendRaw(msg: ClientMessage): boolean {
  const ws = socket;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

function sendOrWarn(msg: ClientMessage): boolean {
  const ok = sendRaw(msg);
  if (!ok) useGame.getState().toast('Not connected to the town right now. Reconnecting…', 'warn');
  return ok;
}

let pendingMove: Extract<ClientMessage, { t: 'move' }> | null = null;
let moveTimer: ReturnType<typeof setTimeout> | null = null;
let lastMoveSent = 0;

function flushMove(): void {
  moveTimer = null;
  if (!pendingMove) return;
  if (sendRaw(pendingMove)) lastMoveSent = performance.now();
  pendingMove = null;
}

/* ------------------------------------------------------------------- lifecycle */

function clearTimers(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (clockTimer) clearInterval(clockTimer);
  if (moveTimer) clearTimeout(moveTimer);
  reconnectTimer = heartbeatTimer = clockTimer = moveTimer = null;
  pendingMove = null;
}

function detachSocket(): void {
  generation++; // invalidates handlers of the old socket
  const ws = socket;
  socket = null;
  if (ws) {
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      ws.close(1000, 'bye');
    } catch {
      /* ignore */
    }
  }
}

function startClock(): void {
  if (clockTimer) return;
  clockTimer = setInterval(() => {
    useGame.setState({ clock: worldTimeOfDay(Date.now() + runtime.serverOffsetMs, DAY_LENGTH_SEC) });
  }, 1000);
}

function startHeartbeat(gen: number): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  const beat = () => {
    if (gen !== generation) return;
    if (Date.now() - lastRx > DEAD_AFTER_MS) {
      // half-open connection: browsers can take a minute to notice, so treat it as closed now
      onSocketClosed(gen, 4000);
      return;
    }
    sendRaw({ t: 'ping', c: Date.now() });
  };
  heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
  sendRaw({ t: 'ping', c: Date.now() });
}

/** The server ended the session on purpose: stop everything, show why, offer a manual "Reconnect". */
function endSession(reason: string): void {
  intentionalClose = true;
  clearTimers();
  detachSocket();
  useExtras.getState().patch({ kicked: true, retryAt: null });
  useGame.setState({ status: 'disconnected', statusDetail: reason });
}

const hooks: HandlerHooks = {
  onWelcome: () => {
    welcomedThisSocket = true;
    attempt = 0;
    startClock();
  },
  onKicked: () => {
    // no reconnect loop after a kick; the UI offers a manual "Reconnect"
    intentionalClose = true;
    clearTimers();
    detachSocket();
  },
  onAuthError: (message) => authFailed(message),
};

function connect(mode: 'connecting' | 'reconnecting' = 'connecting'): void {
  const token = useGame.getState().token;
  if (!token) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  detachSocket();
  intentionalClose = false;
  welcomedThisSocket = false;
  useExtras.getState().patch({ retryAt: null, kicked: false });
  useGame.setState({ status: mode, statusDetail: mode === 'connecting' ? 'Connecting to the town…' : `Reconnecting (attempt ${Math.max(1, attempt)})…` });

  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl(token));
  } catch {
    scheduleReconnect();
    return;
  }
  const gen = ++generation;
  socket = ws;
  lastRx = Date.now();
  ws.onopen = () => {
    if (gen !== generation) return;
    lastRx = Date.now();
    startHeartbeat(gen);
  };
  ws.onmessage = (ev) => {
    if (gen !== generation) return;
    lastRx = Date.now();
    if (typeof ev.data !== 'string') return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data) as ServerMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      handleServerMessage(msg, hooks);
    } catch (err) {
      console.error('[net] failed to handle message', msg.t, err);
    }
  };
  ws.onerror = () => {
    /* a close event always follows; handled there */
  };
  ws.onclose = (ev) => onSocketClosed(gen, ev.code);
}

function onSocketClosed(gen: number, code: number): void {
  if (gen !== generation) return;
  const hadWelcome = welcomedThisSocket;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  detachSocket();
  if (intentionalClose || useExtras.getState().kicked) return;
  const token = useGame.getState().token;
  if (!token) return;
  if (AUTH_CLOSE_CODES.has(code)) {
    authFailed();
    return;
  }
  const endedByServer = NO_RECONNECT_CLOSE_CODES.get(code);
  if (endedByServer) {
    endSession(endedByServer);
    return;
  }
  if (hadWelcome) {
    scheduleReconnect();
    return;
  }
  // The connection never got going. A browser can't see the HTTP status of a failed upgrade, so ask the
  // API whether our token is still valid before retrying forever.
  void verifySession(token).then((state) => {
    if (useGame.getState().token !== token || socket) return; // logged out or already reconnecting
    if (state === 'invalid') authFailed();
    else scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = reconnectDelay(attempt);
  attempt++;
  useExtras.getState().patch({ attempt, retryAt: Date.now() + delay });
  useGame.setState({ status: 'reconnecting', statusDetail: `Connection lost. Retrying (attempt ${attempt})…` });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect('reconnecting');
  }, delay);
}

/** Manual "try again now" (skips the backoff wait; also resets a kicked state). */
export function reconnectNow(): void {
  if (!useGame.getState().token) return;
  attempt = 0;
  connect(useGame.getState().status === 'disconnected' ? 'connecting' : 'reconnecting');
}

async function verifySession(token: string): Promise<'valid' | 'invalid' | 'unknown'> {
  try {
    const res = await fetch(apiUrl('/api/me'), { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 || res.status === 403) return 'invalid';
    return res.ok ? 'valid' : 'unknown';
  } catch {
    return 'unknown';
  }
}

function authFailed(message = 'Your session expired. Please sign in again.'): void {
  intentionalClose = true;
  clearTimers();
  detachSocket();
  clearToken();
  resetSessionState();
  useGame.setState({ loginError: message });
}

function logout(): void {
  intentionalClose = true;
  clearTimers();
  detachSocket();
  clearToken();
  attempt = 0;
  resetSessionState();
  useGame.setState({ loginError: null });
}

/* --------------------------------------------------------------------- HTTP: auth */

function isAccountLike(a: unknown): a is LoginResponse['account'] {
  const o = a as Record<string, unknown> | null;
  return !!o && typeof o.id === 'string' && typeof o.displayName === 'string' && typeof o.coins === 'number';
}

async function login(username: string, email: string): Promise<void> {
  const u = username.trim();
  const e = email.trim();
  const problems = validateLogin(u, e);
  if (!isLoginValid(problems)) {
    useGame.setState({ loginError: problems.username ?? problems.email });
    return;
  }
  useGame.setState({ loading: true, loginError: null });
  try {
    const res = await fetch(apiUrl('/api/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, email: e }),
    });
    const data = (await readJson(res)) as Partial<LoginResponse> | null;
    if (!res.ok || !data || typeof data.token !== 'string' || !isAccountLike(data.account)) {
      useGame.setState({ loading: false, loginError: httpErrorText(data, res.status, 'Login failed. Please check your details and try again.') });
      return;
    }
    saveToken(data.token);
    saveLastLogin({ username: u, email: e });
    attempt = 0;
    useGame.setState({ token: data.token, account: data.account, loading: false, loginError: null });
    connect('connecting');
  } catch {
    useGame.setState({ loading: false, loginError: NETWORK_ERROR_TEXT });
  }
}

function resume(): Promise<boolean> {
  if (resumeInFlight) return resumeInFlight;
  const token = loadToken();
  if (!token) return Promise.resolve(false);
  useGame.setState({ loading: true });
  resumeInFlight = (async () => {
    try {
      const res = await fetch(apiUrl('/api/me'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401 || res.status === 403) {
        clearToken();
        useGame.setState({ loading: false });
        return false;
      }
      const data = (await readJson(res)) as { account?: unknown } | null;
      const account = res.ok ? (isAccountLike(data?.account) ? data?.account : isAccountLike(data) ? data : null) : null;
      if (!account) {
        useGame.setState({ loading: false, loginError: "Couldn't restore your session just now. Try again, or sign in below." });
        return false;
      }
      attempt = 0;
      useGame.setState({ token, account, loading: false, loginError: null });
      connect('connecting');
      return true;
    } catch {
      useGame.setState({ loading: false, loginError: "Can't reach the server to restore your session. Check your connection and try again." });
      return false;
    } finally {
      resumeInFlight = null;
    }
  })();
  return resumeInFlight;
}

/* ------------------------------------------------------------------------ AI */

async function askAi(message: string): Promise<void> {
  const st = useGame.getState();
  const text = message.trim();
  if (!text || !st.token) return;
  if (st.aiBusy) {
    st.toast(AI_BUSY_TEXT, 'info');
    return;
  }
  const pushLine = (line: AiLine) => useGame.setState({ ai: [...useGame.getState().ai, line].slice(-60) });
  if (text.length > AI_MESSAGE_MAX_LENGTH) {
    pushLine({ id: nextAiId(), from: 'ai', text: `Please keep questions under ${AI_MESSAGE_MAX_LENGTH} characters.`, error: true });
    return;
  }
  pushLine({ id: nextAiId(), from: 'you', text });
  useGame.setState({ aiBusy: true });

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, AI_TIMEOUT_MS);
  const fail = (m: string) => pushLine({ id: nextAiId(), from: 'ai', text: m, error: true });
  try {
    const res = await fetch(apiUrl('/api/ai'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${st.token}` },
      body: JSON.stringify({ message: text }),
      signal: ctrl.signal,
    });
    const data = await readJson(res);
    if (isAiError(data) || !res.ok) {
      const err = isAiError(data) ? data : null;
      fail(aiErrorMessage(err, res.status));
      if (err?.code === 'unauthorized' || (!err && res.status === 401)) {
        const token = useGame.getState().token;
        if (token && (await verifySession(token)) === 'invalid') authFailed();
      }
      return;
    }
    if (!isAiResponse(data)) {
      fail(aiErrorMessage({ code: 'unavailable' }));
      return;
    }
    // the player may have logged out while we waited
    if (!useGame.getState().token) return;
    const line = responseToLine(data);
    pushLine(line);
    if (data.usage) useExtras.getState().patch({ aiUsage: data.usage });
    executeAiActions(line.actions ?? [], {
      navigateTo: (id) => gameClient.navigateTo(id),
      setPanel: (p) => useGame.getState().setPanel(p),
      getPanel: () => useGame.getState().panel,
      setReturnPanel: (p) => useExtras.getState().patch({ returnPanel: p }),
      addOffer: (offer) => {
        const cur = useGame.getState().offers;
        if (cur.some((o) => o.offerId === offer.offerId)) return;
        useGame.setState({ offers: [...cur, offer].slice(-5) });
      },
      notify: (t) => useGame.getState().toast(t),
    });
  } catch (err) {
    const aborted = (err as { name?: string })?.name === 'AbortError';
    fail(aiErrorMessage({ code: aborted && timedOut ? 'timeout' : 'unavailable' }));
  } finally {
    clearTimeout(timer);
    useGame.setState({ aiBusy: false });
  }
}

/* ----------------------------------------------------------------- the facade */

const isAnim = (a: unknown): a is Anim => (ANIMS as readonly string[]).includes(a as string);

export const gameClient: GameClientApi = {
  login,
  resume,
  logout,

  sendMove(x, z, ry, anim, seq) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(ry) || !isAnim(anim)) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const wrapped = Math.abs(ry) > 100 ? ((ry % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) : ry;
    pendingMove = {
      t: 'move',
      x: Math.max(-1000, Math.min(1000, x)),
      z: Math.max(-1000, Math.min(1000, z)),
      ry: wrapped,
      anim,
      seq: Math.max(0, Math.floor(seq) || 0),
    };
    const wait = MOVE_MIN_INTERVAL_MS - (performance.now() - lastMoveSent);
    if (wait <= 0) {
      if (moveTimer) clearTimeout(moveTimer);
      flushMove();
    } else if (!moveTimer) {
      moveTimer = setTimeout(flushMove, wait); // latest-wins: the newest pose is sent when the window opens
    }
  },

  sendEmote(anim) {
    if (!isAnim(anim) || !allow('emote', 250)) return;
    sendRaw({ t: 'emote', anim });
  },

  sendChat(text) {
    const clean = sanitizeChat(text);
    if (!clean) return;
    if (!chatAllowed()) {
      useGame.getState().toast("You're chatting too fast. Slow down a little.", 'warn');
      return;
    }
    sendOrWarn({ t: 'chat', text: clean });
  },

  interact(target) {
    if (typeof target !== 'string' || target.length < 1 || target.length > 40) return;
    if (!allow('interact', 250)) return;
    sendRaw({ t: 'interact', target });
  },

  buy(itemId) {
    const st = useGame.getState();
    const item = itemById(itemId);
    if (!item || item.price === null) {
      st.toast("That item isn't for sale.", 'warn');
      return;
    }
    if (st.account && st.account.coins < item.price) {
      st.toast(`Not enough coins for ${item.name} (need ${item.price - st.account.coins} more).`, 'warn');
      return;
    }
    if (!allow('buy', 600)) return;
    sendOrWarn({ t: 'shop_buy', itemId });
  },

  equip(slot, itemId) {
    const st = useGame.getState();
    if (!(EQUIP_SLOTS as readonly string[]).includes(slot)) return;
    if (itemId !== null) {
      const item = itemById(itemId);
      if (!item || item.slot !== slot) {
        st.toast("That item doesn't fit there.", 'warn');
        return;
      }
      if (!(st.account?.inventory[itemId] ?? 0)) {
        st.toast("You don't own that item yet.", 'warn');
        return;
      }
    }
    if (!allow('equip', 300)) return;
    sendOrWarn({ t: 'equip', slot: slot as (typeof EQUIP_SLOTS)[number], itemId });
  },

  acceptMission(offerId) {
    const st = useGame.getState();
    if (!offerId) return;
    if (st.mission) {
      st.toast('Finish or abandon your current mission before accepting another.', 'warn');
      return;
    }
    if (!allow('mission_accept', 600)) return;
    sendOrWarn({ t: 'mission_accept', offerId });
  },

  abandonMission() {
    if (!useGame.getState().mission) return;
    if (!allow('mission_abandon', 600)) return;
    sendOrWarn({ t: 'mission_abandon' });
  },

  askAi,

  navigateTo(locationId) {
    startNavigation(locationId);
  },
};

/* Come back quickly when the tab becomes visible or the network returns. */
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const nudge = () => {
    const st = useGame.getState();
    if (!st.token || intentionalClose) return;
    if (st.status === 'reconnecting' && reconnectTimer) reconnectNow();
  };
  window.addEventListener('online', nudge);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) nudge();
  });
}
