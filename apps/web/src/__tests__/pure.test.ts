import { describe, expect, it } from 'vitest';
import { CHAT_MAX_LENGTH } from '@pixels/shared';
import { RECONNECT_MAX_MS, RECONNECT_MIN_MS, reconnectDelay } from '../net/backoff';
import { validateEmail, validateLogin, validateUsername, isLoginValid } from '../net/validation';
import { hashHue, sanitizeChat, sanitizeName } from '../net/sanitize';
import { apiUrl, wsUrl } from '../net/urls';
import { ClockSync } from '../net/clocksync';
import { httpErrorText } from '../net/http';
import { formatClock, dayPhase, formatCountdown, splitDisplayName, mockSuffix } from '../ui/format';
import { clampToCircle, viewToWorld, worldToView } from '../ui/minimapRender';

describe('reconnectDelay', () => {
  it('grows exponentially from ~500ms and caps at 10s', () => {
    const mid = () => 0.5; // jitter factor 1.0
    expect(reconnectDelay(0, mid)).toBe(500);
    expect(reconnectDelay(1, mid)).toBe(1000);
    expect(reconnectDelay(2, mid)).toBe(2000);
    expect(reconnectDelay(3, mid)).toBe(4000);
    expect(reconnectDelay(4, mid)).toBe(8000);
    expect(reconnectDelay(5, mid)).toBe(RECONNECT_MAX_MS);
    expect(reconnectDelay(40, mid)).toBe(RECONNECT_MAX_MS);
  });
  it('applies +/-20% jitter but never exceeds the cap', () => {
    expect(reconnectDelay(1, () => 0)).toBe(800);
    expect(reconnectDelay(1, () => 0.999)).toBeLessThanOrEqual(1200);
    for (let a = 0; a < 20; a++) {
      for (const r of [0, 0.25, 0.5, 0.75, 1]) {
        const d = reconnectDelay(a, () => r);
        expect(d).toBeGreaterThanOrEqual(RECONNECT_MIN_MS * 0.5);
        expect(d).toBeLessThanOrEqual(RECONNECT_MAX_MS);
      }
    }
  });
  it('is non-decreasing on average (no jitter)', () => {
    let prev = 0;
    for (let a = 0; a < 10; a++) {
      const d = reconnectDelay(a, () => 0.5);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });
});

describe('login validation', () => {
  it('accepts valid usernames and rejects bad ones with helpful text', () => {
    expect(validateUsername('pixel_pal')).toBeNull();
    expect(validateUsername('  abc ')).toBeNull();
    expect(validateUsername('')).toMatch(/choose/i);
    expect(validateUsername('ab')).toMatch(/at least 3/i);
    expect(validateUsername('a'.repeat(17))).toMatch(/at most 16/i);
    expect(validateUsername('no spaces')).toMatch(/letters, numbers/i);
    expect(validateUsername('bad-name!')).toMatch(/letters, numbers/i);
  });
  it('validates emails', () => {
    expect(validateEmail('me@example.com')).toBeNull();
    expect(validateEmail('')).toMatch(/enter/i);
    expect(validateEmail('nope')).toMatch(/valid/i);
    expect(validateEmail('a@b')).toMatch(/valid/i);
    expect(validateEmail('a b@c.com')).toMatch(/valid/i);
    expect(validateEmail('a@b.co' + 'm'.repeat(130))).toMatch(/too long/i);
  });
  it('combines results', () => {
    expect(isLoginValid(validateLogin('abc', 'a@b.cc'))).toBe(true);
    const bad = validateLogin('a', 'x');
    expect(isLoginValid(bad)).toBe(false);
    expect(bad.username).not.toBeNull();
    expect(bad.email).not.toBeNull();
  });
});

describe('chat sanitising', () => {
  it('strips control, zero-width and bidi characters and collapses whitespace', () => {
    expect(sanitizeChat('  hi\u0000 there‮  \n\tfriend​ ')).toBe('hi there friend');
    expect(sanitizeChat('a\u0007b')).toBe('a b');
  });
  it('caps by code points without splitting emoji', () => {
    const long = '\u{1F600}'.repeat(CHAT_MAX_LENGTH + 20);
    const out = sanitizeChat(long);
    expect(Array.from(out)).toHaveLength(CHAT_MAX_LENGTH);
    expect(sanitizeChat('x'.repeat(500)).length).toBe(CHAT_MAX_LENGTH);
  });
  it('keeps angle brackets (React escapes on render) and rejects non-strings', () => {
    expect(sanitizeChat('<3 <b>hi</b>')).toBe('<3 <b>hi</b>');
    expect(sanitizeChat(undefined)).toBe('');
    expect(sanitizeChat(42)).toBe('');
    expect(sanitizeName('x'.repeat(100)).length).toBe(40);
  });
  it('hashes names to a stable hue', () => {
    expect(hashHue('alice#0001')).toBe(hashHue('alice#0001'));
    expect(hashHue('alice#0001')).toBeGreaterThanOrEqual(0);
    expect(hashHue('alice#0001')).toBeLessThan(360);
  });
});

describe('url helpers', () => {
  it('derives same-origin urls by default', () => {
    expect(apiUrl('/api/me', undefined)).toBe('/api/me');
    expect(wsUrl('t k', undefined, { protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws?token=t%20k');
    expect(wsUrl('t', undefined, { protocol: 'https:', host: 'pixels.example' })).toBe('wss://pixels.example/ws?token=t');
  });
  it('honours a VITE_SERVER_URL style base', () => {
    expect(apiUrl('/api/login', 'https://api.example.com')).toBe('https://api.example.com/api/login');
    expect(wsUrl('t', 'https://api.example.com', { protocol: 'http:', host: 'x' })).toBe('wss://api.example.com/ws?token=t');
    expect(wsUrl('t', 'http://localhost:8787', { protocol: 'https:', host: 'x' })).toBe('ws://localhost:8787/ws?token=t');
  });
});

describe('ClockSync', () => {
  it('estimates the offset assuming symmetric latency', () => {
    const c = new ClockSync();
    // client sent at 1000, got reply at 1100 (rtt 100), server said 5050 => server clock is 4000 ahead
    const r = c.add(1000, 5050, 1100);
    expect(r.rtt).toBe(100);
    expect(r.offset).toBe(4000);
    expect(r.best.offset).toBe(4000);
  });
  it('prefers the lowest-RTT sample', () => {
    const c = new ClockSync(3);
    c.add(0, 1000 + 200, 400); // rtt 400, offset 1000
    const good = c.add(1000, 2000 + 10, 1020); // rtt 20, offset 1000
    expect(good.best.rtt).toBe(20);
    const noisy = c.add(2000, 9000, 2600); // rtt 600, junk offset
    expect(noisy.best.rtt).toBe(20);
    c.reset();
    expect(c.add(0, 5, 10).best.rtt).toBe(10);
  });
});

describe('httpErrorText', () => {
  it('prefers server messages and falls back sensibly', () => {
    expect(httpErrorText({ error: 'Username taken.' }, 409)).toBe('Username taken.');
    expect(httpErrorText({ message: 'nope' }, 400)).toBe('nope');
    expect(httpErrorText(null, 429)).toMatch(/too many/i);
    expect(httpErrorText(null, 503)).toMatch(/server/i);
    expect(httpErrorText(null, 400, 'fallback')).toBe('fallback');
  });
});

describe('ui format helpers', () => {
  it('formats the world clock', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(0.5)).toBe('12:00');
    expect(formatClock(0.75)).toBe('18:00');
    expect(formatClock(1.25)).toBe('06:00');
    expect(dayPhase(0.02)).toBe('night');
    expect(dayPhase(0.3)).toBe('dawn');
    expect(dayPhase(0.45)).toBe('morning');
    expect(dayPhase(0.6)).toBe('afternoon');
    expect(dayPhase(0.75)).toBe('dusk');
  });
  it('formats countdowns and names', () => {
    expect(formatCountdown(125_000)).toBe('2:05');
    expect(formatCountdown(-5)).toBe('0:00');
    expect(splitDisplayName('amy#0427')).toEqual({ name: 'amy', tag: '#0427' });
    expect(splitDisplayName('plain')).toEqual({ name: 'plain', tag: '' });
    expect(mockSuffix('40 coins')).toBe('40 coins (mock)');
    expect(mockSuffix('40 coins (mock in-game reward)')).toBe('40 coins (mock in-game reward)');
  });
});

describe('minimap math', () => {
  it('round-trips world <-> view for any rotation', () => {
    for (const rot of [0, 0.7, Math.PI, -2.1]) {
      const v = worldToView(12, -7, 3, 4, rot, 2, 92, 92);
      const w = viewToWorld(v.x, v.y, 3, 4, rot, 2, 92, 92);
      expect(w.x).toBeCloseTo(12, 6);
      expect(w.z).toBeCloseTo(-7, 6);
    }
  });
  it('puts the player at the centre and north (-z) up when rot=0', () => {
    expect(worldToView(5, 5, 5, 5, 0, 3, 100, 100)).toEqual({ x: 100, y: 100 });
    const north = worldToView(0, -10, 0, 0, 0, 2, 100, 100);
    expect(north.x).toBeCloseTo(100);
    expect(north.y).toBeCloseTo(80);
  });
  it('rotating by the camera yaw keeps "camera forward" pointing up', () => {
    // camera yaw 90deg: forward is (-sin, -cos) = (-1, 0) i.e. west; a point to the west must appear above the player
    const yaw = Math.PI / 2;
    const west = worldToView(-10, 0, 0, 0, yaw, 2, 100, 100);
    expect(west.x).toBeCloseTo(100);
    expect(west.y).toBeLessThan(100);
  });
  it('clamps off-map markers onto the rim', () => {
    const p = clampToCircle(300, 100, 100, 100, 80);
    expect(Math.hypot(p.x - 100, p.y - 100)).toBeCloseTo(80);
    expect(p.clamped).toBe(true);
    expect(clampToCircle(110, 100, 100, 100, 80).clamped).toBe(false);
  });
});
