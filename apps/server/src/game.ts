import {
  ANIMS,
  CHAT_MAX_LENGTH,
  ClientMessageSchema,
  COLLIDERS,
  DAY_LENGTH_SEC,
  MAX_PLAYERS,
  PLAYER_RADIUS,
  RUN_SPEED,
  SNAPSHOT_HZ,
  SPAWN,
  WALK_SPEED,
  isBlocked,
  resolveCollisions,
  worldTimeOfDay,
  type Anim,
  type ClientMessage,
  type EquipSlot,
  type Equipped,
  type PlayerView,
  type ServerMessage,
  type SnapshotEntry,
} from '@pixels/shared';
import type { Accounts } from './accounts';
import type { AccountRecord, Database } from './db';
import type { Logger } from './log';
import type { MissionEngine } from './missions';
import { KeyedLimiter, StrikeWindow, TokenBucket } from './rateLimit';
import { isNearShopCounter, type Shop } from './shop';
import { dist2d, normalizeAngle, round, sanitizeText, type Clock } from './util';

/** WebSocket close codes used by the game (4000-4999 are application-defined). */
export const CloseCode = {
  GOING_AWAY: 1001,
  INVALID_TOKEN: 4001,
  SERVER_FULL: 4002,
  KICKED: 4003,
  ABUSE: 4004,
  TIMEOUT: 4005,
  TOO_MANY_CONNECTIONS: 4006,
} as const;

/** Anything the game can talk to: a real `ws` socket (see server.ts) or a fake in tests. */
export interface Transport {
  /** `droppable` frames (snapshots) may be skipped when the socket is backed up */
  send(data: string, opts?: { droppable?: boolean }): void;
  close(code: number, reason?: string): void;
  terminate(): void;
  /** send a protocol-level ping (heartbeat) */
  ping(): void;
}

export const MOVE_LIMITS = {
  minDtMs: 20,
  maxDtMs: 400,
  speedFactor: 1.35,
  slackMeters: 0.3,
  /** if collision resolution moves the point further than this, the move is rejected */
  collisionToleranceMeters: 0.6,
  /** the leaky budget allows this many seconds' worth of max-speed movement to accumulate */
  budgetSeconds: 1,
  violationWindowMs: 10_000,
  violationsBeforeWarning: 5,
} as const;

const EMOTE_ANIMS: readonly Anim[] = ['wave', 'dance', 'cheer'];
export const EMOTE_DURATION_MS = 3000;
/** a saved position is only resumed if the player left less than this long ago */
export const RESUME_WINDOW_MS = 10 * 60_000;
const MAX_INBOUND_BYTES = 4096;
const STRIKE_WINDOW_MS = 10_000;
const STRIKE_LIMIT = 20;
const POSITION_SAVE_MS = 5000;

export interface GameOptions {
  clock: Clock;
  log: Logger;
  maxPlayers?: number;
  heartbeatMs?: number;
  /** concurrent sockets allowed per IP (0 = unlimited) */
  maxConnectionsPerIp?: number;
}

export class PlayerSession {
  alive = true;
  connected = true;
  x: number;
  z: number;
  ry: number;
  anim: Anim = 'idle';
  dirty = false;
  emoteUntil = 0;
  lastMoveAt: number;
  budget: number;
  budgetAt: number;
  lastSeq = 0;
  readonly moveBucket: TokenBucket;
  readonly chatBucket: TokenBucket;
  readonly otherBucket: TokenBucket;
  readonly strikes = new StrikeWindow(STRIKE_WINDOW_MS);
  readonly violations: number[] = [];
  lastViolationWarnAt = -Infinity;
  lastRateToastAt = -Infinity;
  lastPositionSaveAt: number;

  constructor(
    readonly account: AccountRecord,
    readonly transport: Transport,
    readonly ip: string,
    pos: { x: number; z: number; ry: number },
    now: number,
  ) {
    this.x = pos.x;
    this.z = pos.z;
    this.ry = pos.ry;
    this.lastMoveAt = now;
    this.budget = RUN_SPEED * MOVE_LIMITS.speedFactor * MOVE_LIMITS.budgetSeconds + MOVE_LIMITS.slackMeters;
    this.budgetAt = now;
    this.lastPositionSaveAt = now;
    this.moveBucket = new TokenBucket(30, 30, now);
    this.chatBucket = new TokenBucket(3, 1 / 1.2, now);
    this.otherBucket = new TokenBucket(20, 10, now);
  }

  get id(): string {
    return this.account.id;
  }
  get name(): string {
    return this.account.displayName;
  }

  send(msg: ServerMessage, droppable = false): void {
    if (!this.connected) return;
    try {
      this.transport.send(JSON.stringify(msg), droppable ? { droppable: true } : undefined);
    } catch {
      /* socket already gone; the close handler cleans up */
    }
  }

  view(): PlayerView {
    return { id: this.id, name: this.name, x: round(this.x, 2), z: round(this.z, 2), ry: round(this.ry, 2), anim: this.anim, equipped: { ...this.account.equipped } };
  }
}

export const accountMessage = (a: AccountRecord): ServerMessage => ({
  t: 'account',
  coins: a.coins,
  inventory: { ...a.inventory },
  equipped: { ...a.equipped },
});

/** The authoritative realtime world: sessions, movement validation, chat, snapshots, shop/mission message routing. */
export class Game {
  private readonly players = new Map<string, PlayerSession>();
  private readonly byIp = new Map<string, number>();
  private readonly maxPlayers: number;
  private readonly heartbeatMs: number;
  private readonly maxPerIp: number;
  private timers: NodeJS.Timeout[] = [];
  private readonly clock: Clock;
  private readonly log: Logger;
  readonly connectLimiter: KeyedLimiter;

  constructor(
    private readonly deps: { db: Database; accounts: Accounts; missions: MissionEngine; shop: Shop },
    opts: GameOptions,
  ) {
    this.clock = opts.clock;
    this.log = opts.log;
    this.maxPlayers = opts.maxPlayers ?? MAX_PLAYERS;
    this.heartbeatMs = opts.heartbeatMs ?? 30_000;
    this.maxPerIp = opts.maxConnectionsPerIp ?? 12;
    this.connectLimiter = new KeyedLimiter(30, 30 / 60, opts.clock);
  }

  /* ------------------------------------------------------------ lifecycle */

  /** Start the periodic snapshot / housekeeping / heartbeat timers. */
  start(): void {
    if (this.timers.length) return;
    const unref = (t: NodeJS.Timeout) => {
      t.unref?.();
      return t;
    };
    this.timers.push(unref(setInterval(() => this.tick(), Math.round(1000 / SNAPSHOT_HZ))));
    this.timers.push(unref(setInterval(() => this.housekeeping(), 1000)));
    this.timers.push(unref(setInterval(() => this.heartbeat(), this.heartbeatMs)));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Disconnect everybody (server shutdown). */
  shutdown(reason = 'Server is shutting down.'): void {
    this.stop();
    for (const s of [...this.players.values()]) {
      s.send({ t: 'toast', level: 'info', text: reason });
      this.removeSession(s, 'shutdown');
      s.transport.close(CloseCode.GOING_AWAY, 'server shutting down');
    }
  }

  /* ------------------------------------------------------------- queries */

  get playerCount(): number {
    return this.players.size;
  }

  getSession(accountId: string): PlayerSession | undefined {
    return this.players.get(accountId);
  }

  onlineSessions(): PlayerSession[] {
    return [...this.players.values()];
  }

  /** Server-side position of an account: live position if online, else last known, else spawn. */
  getPlayerPosition(accountId: string): { x: number; z: number; ry: number; online: boolean } {
    const s = this.players.get(accountId);
    if (s) return { x: s.x, z: s.z, ry: s.ry, online: true };
    const a = this.deps.db.getAccount(accountId);
    if (a?.lastPos) return { x: a.lastPos.x, z: a.lastPos.z, ry: a.lastPos.ry, online: false };
    return { x: SPAWN.x, z: SPAWN.z, ry: SPAWN.ry, online: false };
  }

  /* ----------------------------------------------------------- messaging */

  sendTo(accountId: string, msg: ServerMessage): void {
    this.players.get(accountId)?.send(msg);
  }

  broadcast(msg: ServerMessage, exceptId?: string, droppable = false): void {
    const data = JSON.stringify(msg);
    for (const s of this.players.values()) {
      if (s.id === exceptId || !s.connected) continue;
      try {
        s.transport.send(data, droppable ? { droppable: true } : undefined);
      } catch {
        /* ignore dead sockets */
      }
    }
  }

  /* ----------------------------------------------------------- connection */

  /**
   * Admit an authenticated account. Returns the session, or null when the connection was refused
   * (the refusal message and close have already been sent on the transport).
   */
  connect(account: AccountRecord, transport: Transport, ip = ''): PlayerSession | null {
    const now = this.clock();
    const existing = this.players.get(account.id);
    if (!existing && this.players.size >= this.maxPlayers) {
      transport.send(JSON.stringify({ t: 'error', code: 'server_full', message: 'The town is full right now. Please try again in a moment.' } satisfies ServerMessage));
      transport.close(CloseCode.SERVER_FULL, 'server full');
      this.log.warn('connection refused: server full');
      return null;
    }
    if (this.maxPerIp > 0 && ip && (this.byIp.get(ip) ?? 0) >= this.maxPerIp && !existing) {
      transport.send(JSON.stringify({ t: 'error', code: 'too_many_connections', message: 'Too many connections from your network.' } satisfies ServerMessage));
      transport.close(CloseCode.TOO_MANY_CONNECTIONS, 'too many connections');
      this.log.warn('connection refused: per-ip cap');
      return null;
    }
    if (existing) {
      existing.send({ t: 'kicked', reason: 'You signed in from another place.' });
      this.removeSession(existing, 'replaced');
      existing.transport.close(CloseCode.KICKED, 'signed in elsewhere');
    }

    const last = account.lastPos;
    const resume =
      last && now - last.at >= 0 && now - last.at < RESUME_WINDOW_MS && !isBlocked(last.x, last.z, PLAYER_RADIUS, COLLIDERS);
    const pos = resume ? { x: last.x, z: last.z, ry: last.ry } : { x: SPAWN.x, z: SPAWN.z, ry: SPAWN.ry };
    const session = new PlayerSession(account, transport, ip, pos, now);
    this.players.set(account.id, session);
    if (ip) this.byIp.set(ip, (this.byIp.get(ip) ?? 0) + 1);
    account.lastSeenAt = now;

    session.send({
      t: 'welcome',
      you: this.deps.accounts.view(account),
      players: [...this.players.values()].map((p) => p.view()),
      worldTime: worldTimeOfDay(now, DAY_LENGTH_SEC),
      serverTime: now,
      mission: this.deps.missions.stateView(account.id),
      position: { x: round(pos.x, 2), z: round(pos.z, 2), ry: round(pos.ry, 2) },
    });
    this.broadcast({ t: 'player_join', player: session.view() }, session.id);
    // a mission that timed out while the player was away is cleared and announced right after the welcome
    this.deps.missions.checkExpiry(account.id);
    this.log.info('player connected', { account: account.id, online: this.players.size });
    return session;
  }

  /** Called by the transport layer when the socket closed. */
  disconnect(session: PlayerSession, reason = 'closed'): void {
    this.removeSession(session, reason);
  }

  private removeSession(s: PlayerSession, reason: string): void {
    if (!s.connected) return;
    s.connected = false;
    if (this.players.get(s.id) === s) {
      this.players.delete(s.id);
      const a = s.account;
      a.lastPos = { x: s.x, z: s.z, ry: s.ry, at: this.clock() };
      a.lastSeenAt = this.clock();
      this.deps.db.save();
      this.broadcast({ t: 'player_leave', id: s.id });
    }
    if (s.ip) {
      const n = (this.byIp.get(s.ip) ?? 1) - 1;
      if (n <= 0) this.byIp.delete(s.ip);
      else this.byIp.set(s.ip, n);
    }
    this.log.info('player disconnected', { account: s.id, reason, online: this.players.size });
  }

  /** Mark a socket as alive (protocol pong or any inbound frame). */
  markAlive(s: PlayerSession): void {
    s.alive = true;
  }

  /* ---------------------------------------------------------------- inbound */

  private strike(s: PlayerSession, now: number, weight: number, why: string): void {
    const total = s.strikes.add(now, weight);
    if (total >= STRIKE_LIMIT && s.connected) {
      this.log.warn('disconnecting abusive client', { account: s.id, why });
      s.send({ t: 'error', code: 'abuse', message: 'Disconnected for sending too many invalid messages.' });
      this.removeSession(s, 'abuse');
      s.transport.close(CloseCode.ABUSE, 'abuse');
    }
  }

  /**
   * Handle one raw inbound WebSocket frame: size check, JSON parse, per-type rate limit, schema validation, dispatch.
   * Invalid input is ignored and counted as a strike.
   */
  async receive(s: PlayerSession, data: string | Buffer, isBinary = false): Promise<void> {
    if (!s.connected) return;
    const now = this.clock();
    s.alive = true;
    const text = typeof data === 'string' ? data : data.toString('utf8');
    if (isBinary || text.length > MAX_INBOUND_BYTES) return this.strike(s, now, 1, 'binary or oversized frame');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return this.strike(s, now, 1, 'invalid json');
    }
    const kind = typeof json === 'object' && json !== null ? (json as { t?: unknown }).t : undefined;
    const bucket = kind === 'move' ? s.moveBucket : kind === 'chat' ? s.chatBucket : s.otherBucket;
    if (!bucket.take(now)) {
      this.strike(s, now, kind === 'move' ? 0.05 : 0.2, 'rate limit');
      if (kind === 'chat' && now - s.lastRateToastAt > 3000) {
        s.lastRateToastAt = now;
        s.send({ t: 'toast', level: 'warn', text: 'You are chatting too fast. Slow down a little.' });
      }
      return;
    }
    const parsed = ClientMessageSchema.safeParse(json);
    if (!parsed.success) return this.strike(s, now, 1, 'schema');
    try {
      await this.dispatch(s, parsed.data, now);
    } catch (err) {
      this.log.error('message handler failed', { account: s.id, type: parsed.data.t, err });
      s.send({ t: 'error', code: 'internal', message: 'Something went wrong handling that.' });
    }
  }

  private async dispatch(s: PlayerSession, m: ClientMessage, now: number): Promise<void> {
    switch (m.t) {
      case 'move':
        return this.onMove(s, m, now);
      case 'chat':
        return this.onChat(s, m.text, now);
      case 'emote':
        return this.onEmote(s, m.anim, now);
      case 'interact':
        return this.onInteract(s, m.target);
      case 'shop_buy':
        return this.onShopBuy(s, m.itemId);
      case 'equip':
        return this.onEquip(s, m.slot, m.itemId);
      case 'mission_accept':
        return this.deps.missions.accept(s.id, m.offerId);
      case 'mission_abandon':
        return this.deps.missions.abandon(s.id);
      case 'ping':
        return s.send({ t: 'pong', c: m.c, serverTime: now });
    }
  }

  /* ----------------------------------------------------------------- moves */

  private onMove(s: PlayerSession, m: Extract<ClientMessage, { t: 'move' }>, now: number): void {
    s.lastSeq = m.seq;
    // leaky distance budget: sustained speed can never exceed RUN_SPEED * 1.35 however the messages are spaced
    const rate = RUN_SPEED * MOVE_LIMITS.speedFactor;
    const cap = rate * MOVE_LIMITS.budgetSeconds + MOVE_LIMITS.slackMeters;
    s.budget = Math.min(cap, s.budget + (Math.max(0, now - s.budgetAt) / 1000) * rate);
    s.budgetAt = now;

    const dtMs = Math.min(MOVE_LIMITS.maxDtMs, Math.max(MOVE_LIMITS.minDtMs, now - s.lastMoveAt));
    const dt = dtMs / 1000;
    const wanted = dist2d(m.x, m.z, s.x, s.z);
    const maxStep = rate * dt + MOVE_LIMITS.slackMeters;
    if (wanted > maxStep || wanted > s.budget) return this.rejectMove(s, m.seq, now, 'speed');

    const [rx, rz] = resolveCollisions(m.x, m.z, PLAYER_RADIUS, COLLIDERS);
    if (dist2d(rx, rz, m.x, m.z) > MOVE_LIMITS.collisionToleranceMeters) return this.rejectMove(s, m.seq, now, 'collision');

    // accepted
    s.budget -= wanted;
    const moved = dist2d(rx, rz, s.x, s.z);
    const speed = moved / dt;
    const ry = normalizeAngle(m.ry);
    let anim = this.plausibleAnim(m.anim, speed);
    if (s.emoteUntil > now) {
      // a server-timed emote is playing: standing still keeps it, moving (or a locomotion anim) cancels it
      if (moved > 0.05 || anim === 'walk' || anim === 'run') s.emoteUntil = 0;
      else if (anim === 'idle') anim = s.anim;
    }
    if (moved > 0.004 || anim !== s.anim || Math.abs(ry - s.ry) > 0.02) s.dirty = true;
    s.x = rx;
    s.z = rz;
    s.ry = ry;
    s.anim = anim;
    s.lastMoveAt = now;
    this.deps.missions.onMove(s.id, s.x, s.z);
  }

  /** `walk`/`run` are only believed when the measured speed supports them. */
  private plausibleAnim(requested: Anim, speed: number): Anim {
    if (!ANIMS.includes(requested)) return 'idle';
    if (requested === 'walk' || requested === 'run') {
      if (speed < 0.25) return 'idle';
      if (requested === 'run' && speed < WALK_SPEED * 0.5) return 'walk';
    }
    return requested;
  }

  private rejectMove(s: PlayerSession, seq: number, now: number, why: string): void {
    s.send({ t: 'correct', x: round(s.x, 3), z: round(s.z, 3), seq });
    const v = s.violations;
    v.push(now);
    while (v.length && v[0] <= now - MOVE_LIMITS.violationWindowMs) v.shift();
    if (v.length >= MOVE_LIMITS.violationsBeforeWarning && now - s.lastViolationWarnAt >= MOVE_LIMITS.violationWindowMs) {
      s.lastViolationWarnAt = now;
      s.send({ t: 'toast', level: 'warn', text: 'Your movement was rejected by the server (too fast or blocked). Please play normally.' });
      this.log.warn('repeated move violations', { account: s.id, why, count: v.length });
    }
  }

  /* ------------------------------------------------------------------ chat */

  private onChat(s: PlayerSession, text: string, now: number): void {
    const clean = sanitizeText(text, CHAT_MAX_LENGTH);
    if (!clean) return;
    // id = the sender's player id (so clients can attach a bubble); name is always the server-side display name
    this.broadcast({ t: 'chat', id: s.id, name: s.name, text: clean, time: now });
  }

  private onEmote(s: PlayerSession, anim: Anim, now: number): void {
    if (anim === 'idle') {
      s.emoteUntil = 0;
      if (EMOTE_ANIMS.includes(s.anim)) {
        s.anim = 'idle';
        s.dirty = true;
      }
      return;
    }
    if (!EMOTE_ANIMS.includes(anim)) return; // walk/run are not emotes
    s.anim = anim;
    s.emoteUntil = now + EMOTE_DURATION_MS;
    s.dirty = true;
  }

  /* ------------------------------------------------------------ interactions */

  private onInteract(s: PlayerSession, target: string): void {
    if (target === 'shop_counter') {
      // the client opens the shop UI itself; the real checks happen at purchase time
      if (!isNearShopCounter(s.x, s.z)) s.send({ t: 'toast', level: 'warn', text: 'You are too far from the shop counter.' });
      return;
    }
    this.deps.missions.interact(s.id, target);
  }

  private async onShopBuy(s: PlayerSession, itemId: string): Promise<void> {
    const res = await this.deps.shop.purchase(s.account, itemId, { x: s.x, z: s.z });
    s.send({ t: 'shop_result', ok: res.ok, itemId: res.itemId, message: res.message, coins: res.coins });
    if (res.ok) s.send(accountMessage(s.account));
  }

  private onEquip(s: PlayerSession, slot: EquipSlot, itemId: string | null): void {
    const res = this.deps.shop.equip(s.account, slot, itemId);
    if (!res.ok) {
      s.send({ t: 'toast', level: 'warn', text: res.error });
      s.send(accountMessage(s.account)); // resync the client's idea of its equipment
      return;
    }
    s.send(accountMessage(s.account));
    this.broadcast({ t: 'appearance', id: s.id, equipped: { ...s.account.equipped } as Equipped });
  }

  /* ------------------------------------------------------------- periodic */

  /** Snapshot tick (SNAPSHOT_HZ): expire emotes, then send each player the changed entries of everyone else. */
  tick(): void {
    const now = this.clock();
    const changed: SnapshotEntry[] = [];
    for (const s of this.players.values()) {
      if (s.emoteUntil && now >= s.emoteUntil) {
        s.emoteUntil = 0;
        if (EMOTE_ANIMS.includes(s.anim)) {
          s.anim = 'idle';
          s.dirty = true;
        }
      }
      if (s.dirty) {
        s.dirty = false;
        changed.push({ id: s.id, x: round(s.x, 2), z: round(s.z, 2), ry: round(s.ry, 2), anim: s.anim });
      }
    }
    if (changed.length === 0) return;
    for (const s of this.players.values()) {
      const entries = changed.some((e) => e.id === s.id) ? changed.filter((e) => e.id !== s.id) : changed;
      if (entries.length === 0) continue;
      s.send({ t: 'snap', time: now, players: entries }, true);
    }
  }

  /** ~1 Hz: mission expiry, periodic position persistence. */
  housekeeping(): void {
    const now = this.clock();
    this.deps.missions.sweep(this.players.keys());
    for (const s of this.players.values()) {
      if (now - s.lastPositionSaveAt >= POSITION_SAVE_MS) {
        s.lastPositionSaveAt = now;
        s.account.lastPos = { x: s.x, z: s.z, ry: s.ry, at: now };
        s.account.lastSeenAt = now;
        this.deps.db.save();
      }
    }
  }

  /** Heartbeat: sockets that did not answer the previous ping are dropped; the rest get a new ping. */
  heartbeat(): void {
    for (const s of [...this.players.values()]) {
      if (!s.alive) {
        this.removeSession(s, 'heartbeat timeout');
        s.transport.terminate();
        continue;
      }
      s.alive = false;
      try {
        s.transport.ping();
      } catch {
        /* the close handler will clean up */
      }
    }
  }
}
