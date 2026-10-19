import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { SPAWN, type ServerMessage } from '@pixels/shared';
import { createServer, type GameServer } from '../src/server';
import { silentLogger } from '../src/log';
import { fakeAssistant, rmDir, tmpDir } from './helpers';

/** A small ws test client that records every server message. */
class WsClient {
  messages: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: (() => void)[] = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.messages.push(JSON.parse(data.toString()) as ServerMessage);
      this.notify();
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.notify();
    });
  }
  private notify() {
    for (const w of this.waiters.splice(0)) w();
  }
  /** wait until `pred` finds a message (checks history first) */
  async waitFor<T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, timeoutMs = 4000): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.messages.find((m): m is Extract<ServerMessage, { t: T }> => m.t === t && pred(m as Extract<ServerMessage, { t: T }>));
      if (hit) return hit;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${t}; got ${this.messages.map((m) => m.t).join(',')}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
  async waitClosed(timeoutMs = 4000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error('timed out waiting for close');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.closed;
  }
  send(msg: unknown): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  close(): void {
    this.ws.close();
  }
  count(t: ServerMessage['t']): number {
    return this.messages.filter((m) => m.t === t).length;
  }
}

let srv: GameServer;
let dir: string;
let base: string;
let wsBase: string;
const clients: WsClient[] = [];

async function boot() {
  dir = tmpDir('pixels-int-');
  srv = createServer({ dataDir: dir, logger: silentLogger, assistant: fakeAssistant(), dbDebounceMs: 5 });
  const port = await srv.start(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}/ws`;
}

async function account(username: string, email: string): Promise<{ token: string; id: string; displayName: string }> {
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, email }) });
  const j = (await res.json()) as { token: string; account: { id: string; displayName: string } };
  return { token: j.token, id: j.account.id, displayName: j.account.displayName };
}

async function connect(token: string): Promise<WsClient> {
  const ws = new WebSocket(`${wsBase}?token=${token}`);
  const c = new WsClient(ws);
  clients.push(c);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return c;
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await srv?.stop();
  if (dir) rmDir(dir);
});

describe('realtime over real websockets', () => {
  it('two players see each other join, move through snapshots, chat with server names, and leave', async () => {
    await boot();
    const alice = await account('alice', 'a@example.com');
    const bob = await account('bobby', 'b@example.com');

    const a = await connect(alice.token);
    const aWelcome = await a.waitFor('welcome');
    expect(aWelcome.you.displayName).toBe(alice.displayName);
    expect(aWelcome.position).toMatchObject({ x: SPAWN.x, z: SPAWN.z });
    expect(typeof aWelcome.serverTime).toBe('number');
    expect(aWelcome.worldTime).toBeGreaterThanOrEqual(0);
    expect(aWelcome.worldTime).toBeLessThan(1);

    const b = await connect(bob.token);
    const bWelcome = await b.waitFor('welcome');
    expect(bWelcome.players.map((p) => p.name).sort()).toEqual([alice.displayName, bob.displayName].sort());
    const join = await a.waitFor('player_join');
    expect(join.player).toMatchObject({ id: bob.id, name: bob.displayName });

    // movement: alice moves a little; bob sees it in a snapshot, alice does not get her own entry back
    await new Promise((r) => setTimeout(r, 120)); // let a little real time pass so the allowed step is realistic
    a.send({ t: 'move', x: SPAWN.x + 0.5, z: SPAWN.z, ry: 1, anim: 'walk', seq: 1 });
    const snap = await b.waitFor('snap', (s) => s.players.some((p) => p.id === alice.id));
    expect(snap.players.find((p) => p.id === alice.id)).toMatchObject({ x: SPAWN.x + 0.5, z: SPAWN.z, ry: 1, anim: 'walk' });
    expect(a.messages.some((m) => m.t === 'snap' && m.players.some((p) => p.id === alice.id))).toBe(false);
    expect(a.count('correct')).toBe(0);

    // chat: server-assigned identity, client-supplied name ignored
    a.send({ t: 'chat', text: '  hello   town ', name: 'Admin#0000' });
    const chatB = await b.waitFor('chat');
    expect(chatB).toMatchObject({ id: alice.id, name: alice.displayName, text: 'hello town' });
    expect(typeof chatB.time).toBe('number');
    const chatA = await a.waitFor('chat');
    expect(chatA.name).toBe(alice.displayName);

    // health sees both
    expect(((await (await fetch(base + '/api/health')).json()) as { players: number }).players).toBe(2);

    // disconnect => leave
    a.close();
    const leave = await b.waitFor('player_leave');
    expect(leave.id).toBe(alice.id);
    await a.waitClosed();
    expect(((await (await fetch(base + '/api/health')).json()) as { players: number }).players).toBe(1);
  });

  it('answers ping with pong', async () => {
    await boot();
    const alice = await account('alice', 'a@example.com');
    const a = await connect(alice.token);
    await a.waitFor('welcome');
    a.send({ t: 'ping', c: 42 });
    const pong = await a.waitFor('pong', (m) => m.c === 42);
    expect(pong.serverTime).toBeGreaterThan(0);
  });

  it('a second connection for the same account kicks the first', async () => {
    await boot();
    const alice = await account('alice', 'a@example.com');
    const first = await connect(alice.token);
    await first.waitFor('welcome');
    // a second device logs in again (fresh token) and connects
    const again = await account('alice', 'a@example.com');
    expect(again.id).toBe(alice.id);
    const second = await connect(again.token);
    await second.waitFor('welcome');
    const kicked = await first.waitFor('kicked');
    expect(kicked.reason).toMatch(/another/i);
    expect((await first.waitClosed()).code).toBe(4003);
    expect(second.closed).toBeNull();
    // the survivor keeps working
    second.send({ t: 'ping', c: 1 });
    await second.waitFor('pong');
    expect(srv.game.playerCount).toBe(1);
  });

  it('rejects invalid tokens with close code 4001', async () => {
    await boot();
    for (const token of ['', 'garbage', '0'.repeat(64)]) {
      const ws = new WebSocket(`${wsBase}?token=${token}`);
      const c = new WsClient(ws);
      clients.push(c);
      expect((await c.waitClosed()).code).toBe(4001);
      expect(c.count('welcome')).toBe(0);
    }
    const noToken = new WsClient(new WebSocket(wsBase));
    clients.push(noToken);
    expect((await noToken.waitClosed()).code).toBe(4001);
    expect(srv.game.playerCount).toBe(0);
  });

  it('ignores invalid messages without dropping the connection, and disconnects a client that keeps abusing', async () => {
    await boot();
    const alice = await account('alice', 'a@example.com');
    const a = await connect(alice.token);
    await a.waitFor('welcome');
    for (const bad of ['not json', '{"t":"move","x":"far","z":0,"ry":0,"anim":"walk","seq":1}', '{"t":"does_not_exist"}', '[]', '42', '{"t":"chat"}']) a.send(bad);
    a.send({ t: 'ping', c: 7 });
    await a.waitFor('pong', (m) => m.c === 7); // still connected and responsive after the junk
    expect(a.closed).toBeNull();
    expect(a.count('correct')).toBe(0);

    for (let i = 0; i < 30; i++) a.send('{"t":"nonsense"}');
    expect((await a.waitClosed()).code).toBe(4004);
    await new Promise((r) => setTimeout(r, 50));
    expect(srv.game.playerCount).toBe(0);
  });

  it('closes connections that send frames over the size limit', async () => {
    await boot();
    const alice = await account('alice', 'a@example.com');
    const a = await connect(alice.token);
    await a.waitFor('welcome');
    a.send(JSON.stringify({ t: 'chat', text: 'x'.repeat(10_000) }));
    expect((await a.waitClosed()).code).toBe(1009);
  });

  it('corrects an impossible move over the wire', async () => {
    await boot();
    const alice = await account('alice', 'a@example.com');
    const a = await connect(alice.token);
    await a.waitFor('welcome');
    a.send({ t: 'move', x: SPAWN.x + 40, z: SPAWN.z, ry: 0, anim: 'run', seq: 9 });
    const c = await a.waitFor('correct');
    expect(c).toMatchObject({ x: SPAWN.x, z: SPAWN.z, seq: 9 });
  });

  it('shop purchase over the wire is refused away from the counter and the reply carries the real balance', async () => {
    await boot();
    const alice = await account('alice', 'a@example.com');
    const a = await connect(alice.token);
    await a.waitFor('welcome');
    a.send({ t: 'shop_buy', itemId: 'coffee', price: 0 });
    const r = await a.waitFor('shop_result');
    expect(r).toMatchObject({ ok: false, coins: 100 });
  });

  it('reconnecting resumes the last position', async () => {
    await boot();
    const alice = await account('alice', 'a@example.com');
    const a = await connect(alice.token);
    await a.waitFor('welcome');
    await new Promise((r) => setTimeout(r, 120));
    a.send({ t: 'move', x: SPAWN.x + 0.5, z: SPAWN.z + 0.2, ry: 0, anim: 'walk', seq: 1 });
    await new Promise((r) => setTimeout(r, 100));
    a.close();
    await a.waitClosed();
    await new Promise((r) => setTimeout(r, 50));
    const a2 = await connect(alice.token);
    const w = await a2.waitFor('welcome');
    expect(w.position.x).toBeCloseTo(SPAWN.x + 0.5, 1);
    expect(w.position.z).toBeCloseTo(SPAWN.z + 0.2, 1);
  });

  it('stop() disconnects clients and flushes the database', async () => {
    await boot();
    const alice = await account('alice', 'a@example.com');
    const a = await connect(alice.token);
    await a.waitFor('welcome');
    await srv.stop();
    expect((await a.waitClosed()).code).toBe(1001);
    const { default: fs } = await import('node:fs');
    const saved = JSON.parse(fs.readFileSync(dir + '/db.json', 'utf8')) as { accounts: { id: string }[] };
    expect(saved.accounts.map((x) => x.id)).toEqual([alice.id]);
  });
});
