import { afterEach, describe, expect, it } from 'vitest';
import { RUN_SPEED, SPAWN, WORLD_BOUNDS, worldTimeOfDay, DAY_LENGTH_SEC } from '@pixels/shared';
import { EMOTE_DURATION_MS, MOVE_LIMITS, RESUME_WINDOW_MS } from '../src/game';
import { FakeTransport, makeHarness, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('connect / welcome', () => {
  it('sends a full welcome at spawn with world time and server time', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    const w = a.last('welcome')!;
    expect(w).toBeTruthy();
    expect(w.position).toEqual({ x: SPAWN.x, z: SPAWN.z, ry: Math.round(SPAWN.ry * 100) / 100 });
    expect(w.serverTime).toBe(h.clock());
    expect(w.worldTime).toBeCloseTo(worldTimeOfDay(h.clock(), DAY_LENGTH_SEC), 10);
    expect(w.you.displayName).toMatch(/^alice#\d{4}$/);
    expect(w.you.email).toBe('a@example.com');
    expect(w.players.map((p) => p.id)).toContain(a.id);
    expect(w.mission).toBeNull();
  });

  it('lists existing players in welcome and broadcasts player_join to them', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    const b = await h.join('bobby', 'b@example.com');
    expect(b.last('welcome')!.players.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    const joins = a.of('player_join');
    expect(joins).toHaveLength(1);
    expect(joins[0].player.id).toBe(b.id);
    expect(joins[0].player.name).toBe(b.account.displayName);
    // the joiner is not told about itself
    expect(b.of('player_join')).toHaveLength(0);
  });

  it('broadcasts player_leave on disconnect and remembers the position', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    const b = await h.join('bobby', 'b@example.com');
    a.clear();
    h.srv.game.disconnect(b.session);
    expect(a.of('player_leave')).toEqual([{ t: 'player_leave', id: b.id }]);
    expect(h.srv.game.playerCount).toBe(1);
    expect(b.account.lastPos).toMatchObject({ x: SPAWN.x, z: SPAWN.z });
  });

  it('refuses connections beyond the player cap with an error and close', async () => {
    h = makeHarness({ maxPlayers: 2 });
    await h.join('alice', 'a@example.com');
    await h.join('bobby', 'b@example.com');
    const { account } = h.signup('carol', 'c@example.com');
    const t = new FakeTransport();
    expect(h.srv.game.connect(account, t)).toBeNull();
    expect(t.sent[0]).toMatchObject({ t: 'error', code: 'server_full' });
    expect(t.closed?.code).toBe(4002);
    expect(h.srv.game.playerCount).toBe(2);
  });

  it('a second connection for the same account kicks the first (and does not count against the cap)', async () => {
    h = makeHarness({ maxPlayers: 1 });
    const first = await h.join('alice', 'a@example.com');
    const t2 = new FakeTransport();
    const s2 = h.srv.game.connect(first.account, t2);
    expect(s2).not.toBeNull();
    expect(first.transport.sent.some((m) => m.t === 'kicked')).toBe(true);
    expect(first.transport.closed?.code).toBe(4003);
    expect(h.srv.game.playerCount).toBe(1);
    // the old session's late close event must not remove the new session
    h.srv.game.disconnect(first.session);
    expect(h.srv.game.playerCount).toBe(1);
    expect(h.srv.game.getSession(first.id)).toBe(s2);
  });

  it('resumes a recent position but spawns at the plaza after the resume window', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    await a.walkTo(10, 14);
    const { x, z } = a;
    h.srv.game.disconnect(a.session);

    h.clock.advance(60_000);
    const again = await h.join('alice', 'a@example.com');
    expect(again.last('welcome')!.position.x).toBeCloseTo(x, 1);
    expect(again.last('welcome')!.position.z).toBeCloseTo(z, 1);
    h.srv.game.disconnect(again.session);

    h.clock.advance(RESUME_WINDOW_MS + 1000);
    const late = await h.join('alice', 'a@example.com');
    expect(late.last('welcome')!.position.x).toBe(SPAWN.x);
    expect(late.last('welcome')!.position.z).toBe(SPAWN.z);
  });
});

describe('move validation', () => {
  it('accepts plausible movement and updates the server position', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    h.clock.advance(100);
    await a.moveTo(SPAWN.x + 0.4, SPAWN.z, 'walk');
    expect(a.x).toBeCloseTo(SPAWN.x + 0.4);
    expect(a.of('correct')).toHaveLength(0);
  });

  it('rejects teleports with a correction to the last good position and the same seq', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    h.clock.advance(100);
    await a.send({ t: 'move', x: SPAWN.x + 30, z: SPAWN.z, ry: 0, anim: 'run', seq: 77 });
    const c = a.last('correct')!;
    expect(c).toMatchObject({ t: 'correct', x: SPAWN.x, z: SPAWN.z, seq: 77 });
    expect(a.x).toBe(SPAWN.x);
  });

  it('clamps speed: ~5 m/s is fine, ~12 m/s is not', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    // 5 m/s for 2 s (0.5 m every 100 ms)
    for (let i = 1; i <= 20; i++) {
      h.clock.advance(100);
      await a.moveTo(SPAWN.x + i * 0.5, SPAWN.z, 'run');
    }
    expect(a.of('correct')).toHaveLength(0);
    const okX = a.x;
    // 12 m/s: 1.2 m every 100 ms exceeds 6*0.1*1.35 + 0.3 = 1.11
    h.clock.advance(100);
    await a.moveTo(okX + 1.2, SPAWN.z, 'run');
    expect(a.of('correct')).toHaveLength(1);
    expect(a.x).toBe(okX);
  });

  it('the per-message allowance scales with elapsed time but dt is clamped to 400 ms', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    // after a long pause only 0.4 s worth of movement is allowed: 6*0.4*1.35+0.3 = 3.54 m
    h.clock.advance(60_000);
    await a.moveTo(SPAWN.x + 4, SPAWN.z, 'run');
    expect(a.of('correct')).toHaveLength(1);
    await a.moveTo(SPAWN.x + 3.4, SPAWN.z, 'run');
    expect(a.x).toBeCloseTo(SPAWN.x + 3.4);
  });

  it('a flood of moves cannot exceed the sustained speed budget', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    // 25 moves of 0.4 m in the same millisecond: each passes the per-message rule (min dt 20 ms => 0.46 m) but not the budget
    h.clock.advance(1000);
    let accepted = 0;
    for (let i = 1; i <= 25; i++) {
      const before = a.x;
      await a.moveTo(before + 0.4, SPAWN.z, 'run');
      if (a.x !== before) accepted++;
    }
    const maxBudget = RUN_SPEED * MOVE_LIMITS.speedFactor * MOVE_LIMITS.budgetSeconds + MOVE_LIMITS.slackMeters;
    expect(accepted * 0.4).toBeLessThanOrEqual(maxBudget + 0.4);
    expect(accepted).toBeLessThan(25);
    expect(a.of('correct').length).toBeGreaterThan(0);
  });

  it('corrects moves that go into a building (collision resolution moved the point > 0.6 m)', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    // Town Hall occupies z 10..22 around x -20; stand just north of it
    a.teleport(-20, 9.5);
    h.clock.advance(200);
    await a.moveTo(-20, 11.2, 'walk'); // 1.7 m is too far in; also > 1.11 m per 200 ms? (allowed 6*0.2*1.35+0.3 = 1.92)
    expect(a.of('correct')).toHaveLength(1);
    expect(a.x).toBe(-20);
    expect(a.z).toBe(9.5);
  });

  it('accepts a slight graze and snaps the player to the collision-free point', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    a.teleport(-20, 9.5);
    h.clock.advance(200);
    await a.moveTo(-20, 9.9, 'walk'); // wall face at z=10, player radius 0.4 => resolves to z=9.6 (0.3 m push)
    expect(a.of('correct')).toHaveLength(0);
    expect(a.z).toBeCloseTo(9.6, 5);
  });

  it('rejects positions outside the world bounds and clamps a graze of the edge', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    const edge = WORLD_BOUNDS.maxX - 0.4;
    a.teleport(edge - 0.2, 0);
    h.clock.advance(300);
    await a.moveTo(WORLD_BOUNDS.maxX + 1.5, 0, 'walk'); // resolves back by 1.5 m
    expect(a.of('correct')).toHaveLength(1);
    await a.moveTo(WORLD_BOUNDS.maxX - 0.1, 0, 'walk'); // 0.3 m beyond the walkable edge: clamped
    expect(a.x).toBeCloseTo(edge, 5);
  });

  it('normalises ry and downgrades implausible animations', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    h.clock.advance(100);
    await a.moveTo(SPAWN.x, SPAWN.z, 'run', 7); // standing still but claims to run
    expect(a.session.anim).toBe('idle');
    expect(a.session.ry).toBeGreaterThanOrEqual(-Math.PI);
    expect(a.session.ry).toBeLessThanOrEqual(Math.PI);
    expect(a.session.ry).toBeCloseTo(7 - 2 * Math.PI, 5);
    // actually running keeps 'run'
    for (let i = 1; i <= 3; i++) {
      h.clock.advance(100);
      await a.moveTo(SPAWN.x + i * 0.55, SPAWN.z, 'run');
    }
    expect(a.session.anim).toBe('run');
  });

  it('ignores schema-invalid moves (NaN-like, out-of-range, wrong types) without changing state', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    h.clock.advance(100);
    for (const bad of [
      '{"t":"move","x":"1","z":2,"ry":0,"anim":"walk","seq":1}',
      '{"t":"move","x":1e9,"z":2,"ry":0,"anim":"walk","seq":1}',
      '{"t":"move","x":1,"z":2,"ry":0,"anim":"fly","seq":1}',
      '{"t":"move","x":1,"z":2,"ry":0,"anim":"walk","seq":-1}',
      '{"t":"teleport","x":1,"z":2}',
      '[]',
      'null',
      'nope',
    ]) {
      await a.sendRaw(bad);
    }
    expect(a.x).toBe(SPAWN.x);
    expect(a.of('correct')).toHaveLength(0);
    expect(h.srv.game.playerCount).toBe(1);
  });

  it('warns with a toast after 5 violations in 10 s (once per window)', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    for (let i = 0; i < 4; i++) {
      h.clock.advance(100);
      await a.moveTo(SPAWN.x + 40, SPAWN.z, 'run');
    }
    expect(a.of('toast')).toHaveLength(0);
    h.clock.advance(100);
    await a.moveTo(SPAWN.x + 40, SPAWN.z, 'run');
    expect(a.of('toast')).toHaveLength(1);
    expect(a.of('toast')[0].level).toBe('warn');
    expect(a.of('correct')).toHaveLength(5);
    h.clock.advance(100);
    await a.moveTo(SPAWN.x + 40, SPAWN.z, 'run');
    expect(a.of('toast')).toHaveLength(1); // not repeated within the window
  });

  it('players can never move other players: a move only ever touches the sender', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    const b = await h.join('bobby', 'b@example.com');
    h.clock.advance(100);
    await a.send({ t: 'move', x: SPAWN.x + 0.3, z: SPAWN.z, ry: 0, anim: 'walk', seq: 1, id: b.id } as never);
    expect(b.x).toBe(SPAWN.x);
    expect(a.x).toBeCloseTo(SPAWN.x + 0.3);
  });
});

describe('snapshots and emotes', () => {
  it('broadcasts only changed players, never to themselves, and nothing when nothing changed', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    const b = await h.join('bobby', 'b@example.com');
    const c = await h.join('carol', 'c@example.com');
    a.clear();
    b.clear();
    c.clear();
    h.srv.game.tick();
    expect(a.of('snap')).toHaveLength(0); // nobody moved

    h.clock.advance(100);
    await a.moveTo(SPAWN.x + 0.4, SPAWN.z, 'walk', 1.5);
    h.srv.game.tick();
    expect(a.of('snap')).toHaveLength(0); // alone in the snapshot: filtered out for the mover
    for (const other of [b, c]) {
      const snap = other.of('snap');
      expect(snap).toHaveLength(1);
      expect(snap[0].time).toBe(h.clock());
      expect(snap[0].players).toEqual([{ id: a.id, x: SPAWN.x + 0.4, z: SPAWN.z, ry: 1.5, anim: 'walk' }]);
    }
    b.clear();
    h.srv.game.tick();
    expect(b.of('snap')).toHaveLength(0); // dirty flags were cleared
  });

  it('a snapshot with several movers gives each recipient the others', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    const b = await h.join('bobby', 'b@example.com');
    a.clear();
    b.clear();
    h.clock.advance(100);
    await a.moveTo(SPAWN.x + 0.4, SPAWN.z, 'walk');
    await b.moveTo(SPAWN.x - 0.4, SPAWN.z, 'walk');
    h.srv.game.tick();
    expect(a.last('snap')!.players.map((p) => p.id)).toEqual([b.id]);
    expect(b.last('snap')!.players.map((p) => p.id)).toEqual([a.id]);
  });

  it('emotes show for ~3 s then revert to idle on the server', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    const b = await h.join('bobby', 'b@example.com');
    b.clear();
    await a.send({ t: 'emote', anim: 'dance' });
    h.srv.game.tick();
    expect(b.last('snap')!.players[0]).toMatchObject({ id: a.id, anim: 'dance' });

    // a client that keeps sending "idle" moves while standing still does not cancel the emote
    h.clock.advance(1000);
    await a.moveTo(SPAWN.x, SPAWN.z, 'idle');
    h.srv.game.tick();
    expect(a.session.anim).toBe('dance');

    b.clear();
    h.clock.advance(EMOTE_DURATION_MS);
    h.srv.game.tick();
    expect(a.session.anim).toBe('idle');
    expect(b.last('snap')!.players[0]).toMatchObject({ id: a.id, anim: 'idle' });
  });

  it('moving cancels an emote; non-emote anims are rejected as emotes', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    await a.send({ t: 'emote', anim: 'run' });
    expect(a.session.anim).toBe('idle');
    await a.send({ t: 'emote', anim: 'cheer' });
    expect(a.session.anim).toBe('cheer');
    h.clock.advance(100);
    await a.moveTo(SPAWN.x + 0.5, SPAWN.z, 'walk');
    expect(a.session.anim).toBe('walk');
    h.clock.advance(EMOTE_DURATION_MS + 10);
    h.srv.game.tick();
    expect(a.session.anim).toBe('walk');
  });
});

describe('chat', () => {
  it('broadcasts with the server-assigned name, id and time, ignoring any client-supplied name', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    const b = await h.join('bobby', 'b@example.com');
    b.clear();
    a.clear();
    await a.send({ t: 'chat', text: 'hello   world', name: 'Admin#0000', id: 'forged' } as never);
    for (const c of [a, b]) {
      expect(c.of('chat')).toEqual([{ t: 'chat', id: a.id, name: a.account.displayName, text: 'hello world', time: h.clock() }]);
    }
  });

  it('strips control characters, collapses whitespace, trims and truncates; keeps links', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    a.clear();
    await a.send({ t: 'chat', text: '  hi\u0000\u0007 \n\t there‮  https://example.com/x?y=1  ' });
    expect(a.last('chat')!.text).toBe('hi there https://example.com/x?y=1');
    h.clock.advance(5000);
    await a.send({ t: 'chat', text: 'x'.repeat(250) });
    expect(a.last('chat')!.text).toHaveLength(140);
  });

  it('ignores empty / whitespace-only messages', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    a.clear();
    await a.send({ t: 'chat', text: '   \n\t  ' });
    await a.send({ t: 'chat', text: '\u0000\u0001' });
    expect(a.of('chat')).toHaveLength(0);
  });
});

describe('heartbeat and ping', () => {
  it('answers ping with pong carrying the server time', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    a.clear();
    await a.send({ t: 'ping', c: 12345 });
    expect(a.last('pong')).toEqual({ t: 'pong', c: 12345, serverTime: h.clock() });
  });

  it('pings live sockets and terminates ones that never answer', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    const b = await h.join('bobby', 'b@example.com');
    a.clear();
    h.srv.game.heartbeat();
    expect(a.transport.pings).toBe(1);
    expect(b.transport.pings).toBe(1);
    h.srv.game.markAlive(a.session); // a answers with a pong
    h.srv.game.heartbeat();
    expect(a.transport.pings).toBe(2);
    expect(b.transport.terminated).toBe(true);
    expect(h.srv.game.playerCount).toBe(1);
    expect(a.of('player_leave')).toEqual([{ t: 'player_leave', id: b.id }]);
  });
});
