import { afterEach, describe, expect, it } from 'vitest';
import { SPAWN } from '@pixels/shared';
import { KeyedLimiter, StrikeWindow, TokenBucket } from '../src/rateLimit';
import { makeClock, makeHarness, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then refills over time', () => {
    const b = new TokenBucket(3, 1, 0);
    expect([b.take(0), b.take(0), b.take(0), b.take(0)]).toEqual([true, true, true, false]);
    expect(b.waitSec(0)).toBeCloseTo(1);
    expect(b.take(999)).toBe(false);
    expect(b.take(1000)).toBe(true);
    expect(b.take(1000)).toBe(false);
    // never exceeds capacity however long it idles
    expect([b.take(1e9), b.take(1e9), b.take(1e9), b.take(1e9)]).toEqual([true, true, true, false]);
  });

  it('survives a clock that goes backwards', () => {
    const b = new TokenBucket(2, 1, 1000);
    expect(b.take(1000)).toBe(true);
    expect(b.take(500)).toBe(true);
    expect(b.take(500)).toBe(false);
  });
});

describe('KeyedLimiter', () => {
  it('limits per key independently and forgets idle keys', () => {
    const clock = makeClock(0);
    const l = new KeyedLimiter(2, 1, clock);
    expect(l.take('a')).toBe(true);
    expect(l.take('a')).toBe(true);
    expect(l.take('a')).toBe(false);
    expect(l.take('b')).toBe(true);
    expect(l.retryAfterSec('a')).toBe(1);
    clock.advance(1000);
    expect(l.take('a')).toBe(true);
    clock.advance(60_000);
    for (let i = 0; i < 300; i++) l.take('k' + i); // triggers pruning of the idle buckets
    expect(l.size).toBeLessThanOrEqual(302);
  });
});

describe('StrikeWindow', () => {
  it('sums weights inside the window only', () => {
    const w = new StrikeWindow(1000);
    expect(w.add(0, 1)).toBe(1);
    expect(w.add(500, 2)).toBe(3);
    expect(w.add(1001, 1)).toBe(3); // the t=0 event dropped out
    expect(w.count(2000)).toBe(1);
  });
});

describe('per-connection message limits', () => {
  it('chat: burst of 3, then dropped with a (single) warning toast, then 1 per 1.2 s', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    const b = await h.join('bobby', 'b@example.com');
    b.clear();
    a.clear();
    for (let i = 0; i < 6; i++) await a.send({ t: 'chat', text: 'msg ' + i });
    expect(b.of('chat').map((c) => c.text)).toEqual(['msg 0', 'msg 1', 'msg 2']);
    expect(a.of('toast')).toHaveLength(1);
    h.clock.advance(1100);
    await a.send({ t: 'chat', text: 'too soon' });
    expect(b.of('chat')).toHaveLength(3);
    h.clock.advance(200);
    await a.send({ t: 'chat', text: 'now fine' });
    expect(b.of('chat').map((c) => c.text)).toContain('now fine');
  });

  it('moves: about 30 per second; the excess is silently dropped', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    h.clock.advance(1000);
    let seq = 0;
    // 50 identical (valid, zero-length) moves in one instant
    for (let i = 0; i < 50; i++) await a.send({ t: 'move', x: SPAWN.x, z: SPAWN.z, ry: 0, anim: 'idle', seq: seq++ });
    expect(a.of('correct')).toHaveLength(0);
    expect(a.session.moveBucket.take(h.clock())).toBe(false);
    h.clock.advance(1000);
    expect(a.session.moveBucket.take(h.clock())).toBe(true);
    expect(h.srv.game.playerCount).toBe(1); // dropped moves are not abuse at this volume
  });

  it('other messages: ~10 per second with a burst of 20', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    a.clear();
    for (let i = 0; i < 40; i++) await a.send({ t: 'ping', c: i });
    expect(a.of('pong')).toHaveLength(20);
    h.clock.advance(1000);
    for (let i = 0; i < 40; i++) await a.send({ t: 'ping', c: i });
    expect(a.of('pong')).toHaveLength(30);
  });

  it('disconnects clients that keep sending invalid messages (strikes)', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    const b = await h.join('bobby', 'b@example.com');
    b.clear();
    for (let i = 0; i < 19; i++) await a.sendRaw('{"t":"nonsense"}');
    expect(a.transport.closed).toBeNull();
    await a.sendRaw('not json');
    expect(a.transport.closed?.code).toBe(4004);
    expect(a.of('error').pop()).toMatchObject({ code: 'abuse' });
    expect(h.srv.game.playerCount).toBe(1);
    expect(b.of('player_leave')).toHaveLength(1);
    // a closed session ignores anything further
    await a.send({ t: 'chat', text: 'ghost' });
    expect(b.of('chat')).toHaveLength(0);
  });

  it('strikes expire: occasional bad messages never disconnect', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    for (let i = 0; i < 60; i++) {
      await a.sendRaw('garbage');
      h.clock.advance(2000);
    }
    expect(a.transport.closed).toBeNull();
  });

  it('treats binary and oversized frames as abuse', async () => {
    h = makeHarness();
    const a = await h.join('alice', 'a@example.com');
    await h.srv.game.receive(a.session, Buffer.from([1, 2, 3]), true);
    await a.sendRaw('x'.repeat(5000));
    expect(a.transport.closed).toBeNull(); // two strikes only
    expect(a.session.strikes.count(h.clock())).toBe(2);
  });
});
