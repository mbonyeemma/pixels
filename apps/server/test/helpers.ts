import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findPath, type ClientMessage, type MissionStateView, type ServerMessage } from '@pixels/shared';
import type { Assistant } from '../src/ai/contract';
import type { AccountRecord } from '../src/db';
import type { PlayerSession, Transport } from '../src/game';
import { silentLogger } from '../src/log';
import { createServer, type GameServer, type ServerOptions } from '../src/server';

export interface TestClock {
  (): number;
  advance(ms: number): number;
  set(ms: number): void;
}

/** Deterministic clock starting at 2026-01-15 12:00 UTC. */
export function makeClock(start = Date.UTC(2026, 0, 15, 12, 0, 0)): TestClock {
  let t = start;
  const fn = (() => t) as TestClock;
  fn.advance = (ms: number) => (t += ms);
  fn.set = (ms: number) => {
    t = ms;
  };
  return fn;
}

export class FakeTransport implements Transport {
  sent: ServerMessage[] = [];
  closed: { code: number; reason?: string } | null = null;
  terminated = false;
  pings = 0;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }
  close(code: number, reason?: string): void {
    this.closed = { code, reason };
  }
  terminate(): void {
    this.terminated = true;
  }
  ping(): void {
    this.pings++;
  }
}

export function tmpDir(prefix = 'pixels-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** A fake Assistant. Pass a handler to customise; by default it answers with a canned reply. */
export function fakeAssistant(handler?: Assistant['handle']): Assistant & { calls: { playerKey: string; message: string }[] } {
  const calls: { playerKey: string; message: string }[] = [];
  return {
    calls,
    async handle(input) {
      calls.push({ playerKey: input.playerKey, message: input.message });
      if (handler) return handler(input);
      return {
        reply: 'ok',
        interpretation: 'test',
        plan: [],
        actions: [],
        provider: 'fake',
        usage: { remainingToday: 99, limitPerDay: 100 },
      };
    },
    describe: () => ({ provider: 'fake', model: 'fake-1' }),
  };
}

/** A connected player driven through the same code path as a real socket. */
export class TestClient {
  corrections = 0;
  private seq = 1;

  constructor(
    readonly h: Harness,
    readonly account: AccountRecord,
    readonly session: PlayerSession,
    readonly transport: FakeTransport,
    readonly token: string,
  ) {}

  get id(): string {
    return this.account.id;
  }
  get x(): number {
    return this.session.x;
  }
  get z(): number {
    return this.session.z;
  }
  get messages(): ServerMessage[] {
    return this.transport.sent;
  }

  of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.transport.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    const all = this.of(t);
    return all[all.length - 1];
  }
  clear(): void {
    this.transport.sent.length = 0;
  }

  /** send a typed client message through the validated path */
  async send(msg: ClientMessage): Promise<void> {
    await this.h.srv.game.receive(this.session, JSON.stringify(msg));
  }
  async sendRaw(raw: string): Promise<void> {
    await this.h.srv.game.receive(this.session, raw);
  }

  async moveTo(x: number, z: number, anim: 'idle' | 'walk' | 'run' = 'walk', ry = 0): Promise<void> {
    await this.send({ t: 'move', x, z, ry, anim, seq: this.seq++ });
  }

  /** place the player (white-box shortcut for tests that are not about movement) */
  teleport(x: number, z: number): void {
    this.session.x = x;
    this.session.z = z;
  }

  /** walk along the shared nav path in ~0.5 m steps at `speed` m/s, advancing the test clock. Every step is a validated move. */
  async walkTo(x: number, z: number, speed = 5): Promise<void> {
    const waypoints = findPath({ x: this.x, z: this.z }, { x, z });
    if (!waypoints) throw new Error(`no path to ${x},${z}`);
    let cx = this.x;
    let cz = this.z;
    for (const wp of waypoints) {
      for (;;) {
        const d = Math.hypot(wp.x - cx, wp.z - cz);
        if (d < 1e-6) break;
        const step = Math.min(0.5, d);
        cx += ((wp.x - cx) / d) * step;
        cz += ((wp.z - cz) / d) * step;
        this.h.clock.advance(Math.max(25, (step / speed) * 1000));
        const before = this.of('correct').length;
        await this.moveTo(cx, cz, 'walk');
        if (this.of('correct').length > before) throw new Error(`server corrected walk at ${cx.toFixed(2)},${cz.toFixed(2)}`);
      }
    }
  }

  mission(): MissionStateView | null {
    const w = this.last('welcome');
    const events = this.of('mission');
    if (events.length) return events[events.length - 1].state;
    return w ? w.mission : null;
  }
}

export interface Harness {
  srv: GameServer;
  clock: TestClock;
  dir: string;
  /** create an account (or log in) and connect it as a player */
  join(username: string, email: string): Promise<TestClient>;
  /** log in only */
  signup(username: string, email: string): { token: string; account: AccountRecord };
  close(): Promise<void>;
}

export function makeHarness(opts: Partial<ServerOptions> = {}): Harness {
  const clock = makeClock();
  const dir = opts.dataDir ?? tmpDir();
  const srv = createServer({
    dataDir: dir,
    now: clock,
    logger: silentLogger,
    timers: false,
    dbDebounceMs: 5,
    assistant: fakeAssistant(),
    maxConnectionsPerIp: 0,
    ...opts,
  });
  const h: Harness = {
    srv,
    clock,
    dir,
    signup(username, email) {
      const r = srv.accounts.login(username, email);
      if (!r.ok) throw new Error(r.error);
      return { token: r.token, account: r.account };
    },
    async join(username, email) {
      const { token, account } = h.signup(username, email);
      const transport = new FakeTransport();
      const session = srv.game.connect(account, transport);
      if (!session) throw new Error('connection refused');
      return new TestClient(h, account, session, transport, token);
    },
    async close() {
      await srv.stop();
      if (!opts.dataDir) rmDir(dir);
    },
  };
  return h;
}
