import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { STARTING_COINS, type AiErrorResponse, type AiResponse } from '@pixels/shared';
import { createServer, type GameServer } from '../src/server';
import { silentLogger } from '../src/log';
import { fakeAssistant, makeClock, rmDir, tmpDir } from './helpers';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

async function boot(opts: Partial<Parameters<typeof createServer>[0]> = {}): Promise<{ srv: GameServer; base: string; dir: string }> {
  const dir = opts.dataDir ?? tmpDir();
  const srv = createServer({ dataDir: dir, logger: silentLogger, assistant: fakeAssistant(), dbDebounceMs: 5, ...opts });
  const port = await srv.start(0, '127.0.0.1');
  cleanup.push(async () => {
    await srv.stop();
    if (!opts.dataDir) rmDir(dir);
  });
  return { srv, base: `http://127.0.0.1:${port}`, dir };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const login = (base: string, username: string, email: string) => post(base + '/api/login', { username, email });
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('POST /api/login', () => {
  it('creates a new account with username#tag, starting coins and a token', async () => {
    const { base } = await boot();
    const res = await login(base, 'Alice_1', 'Alice@Example.com');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await res.json()) as { token: string; account: Record<string, unknown> };
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.account).toMatchObject({
      username: 'Alice_1',
      email: 'alice@example.com',
      coins: STARTING_COINS,
      inventory: {},
      equipped: {},
    });
    expect(body.account.tag).toMatch(/^\d{4}$/);
    expect(body.account.displayName).toBe(`Alice_1#${body.account.tag}`);
    expect(String(body.account.id).length).toBeGreaterThan(8);
  });

  it('existing email (any case) returns the same account with a fresh token and ignores the supplied username', async () => {
    const { base } = await boot();
    const first = (await (await login(base, 'alice', 'a@example.com')).json()) as { token: string; account: { id: string; displayName: string } };
    const second = (await (await login(base, 'other_name', 'A@EXAMPLE.COM')).json()) as typeof first;
    expect(second.account.id).toBe(first.account.id);
    expect(second.account.displayName).toBe(first.account.displayName);
    expect(second.token).not.toBe(first.token);
    // both devices stay signed in
    for (const t of [first.token, second.token]) {
      const me = await fetch(base + '/api/me', { headers: auth(t) });
      expect(me.status).toBe(200);
      expect(((await me.json()) as { id: string }).id).toBe(first.account.id);
    }
  });

  it('gives the same username different unique tags (case-insensitively)', async () => {
    const { base } = await boot({ loginBurst: 1000, loginPerMinute: 1000 });
    const names = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const name = i % 2 ? 'Bob' : 'bob';
      const r = (await (await login(base, name, `bob${i}@example.com`)).json()) as { account: { tag: string } };
      expect(names.has(r.account.tag), `tag ${r.account.tag} reused`).toBe(false);
      names.add(r.account.tag);
    }
    expect(names.size).toBe(40);
  });

  it('finds a free tag when a username is nearly full, then reports it full', async () => {
    const { srv, base } = await boot();
    const now = Date.now();
    for (let n = 0; n < 9999; n++) {
      const tag = String(n).padStart(4, '0');
      srv.db.insertAccount({
        id: 'id' + n, email: `e${n}@x.io`, username: 'crowd', tag, displayName: `crowd#${tag}`, coins: 0, inventory: {}, equipped: {}, tokens: [],
        createdAt: now, lastLoginAt: now, lastSeenAt: now, lastPos: null, missionClaims: {}, dailyRewards: { day: '', coins: 0 }, lastCompletedAt: {}, activeMission: null, wallet: null,
      });
    }
    const last = (await (await login(base, 'crowd', 'last@example.com')).json()) as { account: { tag: string } };
    expect(last.account.tag).toBe('9999');
    const full = await login(base, 'crowd', 'nomore@example.com');
    expect(full.status).toBe(409);
    expect(((await full.json()) as { error: string }).error).toMatch(/full/i);
    // other usernames are unaffected
    expect((await login(base, 'someone', 'someone@example.com')).status).toBe(200);
  });

  it('trims surrounding whitespace on both fields', async () => {
    const { base } = await boot();
    const r = await login(base, '  carol  ', '  carol@example.com ');
    expect(r.status).toBe(200);
    expect(((await r.json()) as { account: { username: string; email: string } }).account).toMatchObject({ username: 'carol', email: 'carol@example.com' });
  });

  it.each([
    ['username too short', { username: 'ab', email: 'a@example.com' }],
    ['username too long', { username: 'a'.repeat(17), email: 'a@example.com' }],
    ['username with spaces', { username: 'bad name', email: 'a@example.com' }],
    ['username with symbols', { username: 'bad<name>', email: 'a@example.com' }],
    ['unicode lookalike', { username: 'аlice', email: 'a@example.com' }],
    ['email without @', { username: 'alice', email: 'nope' }],
    ['email without tld', { username: 'alice', email: 'a@b' }],
    ['email with spaces inside', { username: 'alice', email: 'a b@example.com' }],
    ['email too long', { username: 'alice', email: 'a'.repeat(120) + '@example.com' }],
    ['missing fields', {}],
    ['wrong types', { username: 5, email: ['a@example.com'] }],
    ['array body', []],
    ['null body', null],
  ])('rejects invalid input: %s (400, nothing created)', async (_name, body) => {
    const { base, srv } = await boot();
    const res = await post(base + '/api/login', body as object);
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(typeof j.error).toBe('string');
    expect(j.error.length).toBeGreaterThan(3);
    expect(srv.db.accountCount).toBe(0);
  });

  it('rejects malformed JSON and empty bodies with 400', async () => {
    const { base } = await boot();
    expect((await post(base + '/api/login', '{not json')).status).toBe(400);
    expect((await post(base + '/api/login', '')).status).toBe(400);
  });

  it('enforces the 10 KB body limit with 413', async () => {
    const { base, srv } = await boot();
    const res = await post(base + '/api/login', { username: 'alice', email: 'a@example.com', pad: 'x'.repeat(11 * 1024) });
    expect(res.status).toBe(413);
    expect(srv.db.accountCount).toBe(0);
    // the server stays healthy afterwards
    expect((await fetch(base + '/api/health')).status).toBe(200);
  });

  it('rate limits logins per IP with 429 + Retry-After', async () => {
    const clock = makeClock();
    const { base } = await boot({ now: clock, loginBurst: 3, loginPerMinute: 3 });
    for (let i = 0; i < 3; i++) expect((await login(base, 'alice', `a${i}@example.com`)).status).toBe(200);
    const blocked = await login(base, 'alice', 'a9@example.com');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    clock.advance(21_000); // refill: 3 per minute => 1 token per 20 s
    expect((await login(base, 'alice', 'a9@example.com')).status).toBe(200);
  });

  it('ignores X-Forwarded-For unless trustProxy is set', async () => {
    const a = await boot({ loginBurst: 1, loginPerMinute: 1 });
    expect((await post(a.base + '/api/login', { username: 'alice', email: 'a1@example.com' }, { 'x-forwarded-for': '1.1.1.1' })).status).toBe(200);
    expect((await post(a.base + '/api/login', { username: 'alice', email: 'a2@example.com' }, { 'x-forwarded-for': '2.2.2.2' })).status).toBe(429);
    const b = await boot({ loginBurst: 1, loginPerMinute: 1, trustProxy: true });
    expect((await post(b.base + '/api/login', { username: 'alice', email: 'a1@example.com' }, { 'x-forwarded-for': '1.1.1.1' })).status).toBe(200);
    expect((await post(b.base + '/api/login', { username: 'alice', email: 'a2@example.com' }, { 'x-forwarded-for': '2.2.2.2' })).status).toBe(200);
  });
});

describe('GET /api/me and /api/health', () => {
  it('returns the account for a valid bearer token and 401 otherwise', async () => {
    const { base } = await boot();
    const { token, account } = (await (await login(base, 'alice', 'a@example.com')).json()) as { token: string; account: { id: string } };
    const ok = await fetch(base + '/api/me', { headers: auth(token) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: account.id, coins: STARTING_COINS, email: 'a@example.com' });
    const bad: Record<string, string>[] = [
      {},
      auth('0'.repeat(64)),
      auth('nonsense'),
      { authorization: token },
      { authorization: `Basic ${token}` },
      { authorization: `Bearer ${token}x` },
    ];
    for (const headers of bad) {
      const r = await fetch(base + '/api/me', { headers });
      expect(r.status, JSON.stringify(headers)).toBe(401);
    }
  });

  it('health reports ok, player count, uptime and the AI provider', async () => {
    const clock = makeClock();
    const { base } = await boot({ now: clock });
    clock.advance(12_500);
    const res = await fetch(base + '/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, players: 0, uptime: 13, ai: { provider: 'fake', model: 'fake-1' } });
  });

  it('answers CORS preflight and unknown routes', async () => {
    const { base } = await boot();
    const pre = await fetch(base + '/api/login', { method: 'OPTIONS', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/authorization/i);
    expect((await fetch(base + '/api/nope')).status).toBe(404);
    expect((await fetch(base + '/api/login')).status).toBe(405);
    expect((await fetch(base + '/api/health', { method: 'POST' })).status).toBe(405);
  });
});

describe('POST /api/ai', () => {
  async function aiSetup(handler?: Parameters<typeof fakeAssistant>[0], opts: Partial<Parameters<typeof createServer>[0]> = {}) {
    const assistant = fakeAssistant(handler);
    const ctx = await boot({ assistant, ...opts });
    const { token, account } = (await (await login(ctx.base, 'alice', 'a@example.com')).json()) as { token: string; account: { id: string; displayName: string } };
    return { ...ctx, assistant, token, account };
  }
  const ask = (base: string, token: string | null, message: unknown) =>
    post(base + '/api/ai', { message }, token ? auth(token) : {});

  it('requires a bearer token', async () => {
    const { base, assistant } = await aiSetup();
    const res = await ask(base, null, 'hi');
    expect(res.status).toBe(401);
    expect(((await res.json()) as AiErrorResponse).code).toBe('unauthorized');
    expect(assistant.calls).toHaveLength(0);
  });

  it('validates the message (1..300 chars, string)', async () => {
    const { base, token, assistant } = await aiSetup();
    for (const m of ['', '   ', 'x'.repeat(301), 5, null, undefined]) {
      const res = await ask(base, token, m);
      expect(res.status, String(m)).toBe(400);
      expect(((await res.json()) as AiErrorResponse).code).toBe('bad_request');
    }
    expect(assistant.calls).toHaveLength(0);
  });

  it('calls the assistant with the account id as playerKey and a working AiGameApi', async () => {
    const reply: AiResponse = { reply: 'hello', interpretation: 'i', plan: ['p'], actions: [], provider: 'fake', usage: { remainingToday: 5, limitPerDay: 100 } };
    const { base, token, account, assistant } = await aiSetup(async ({ api }) => ({ ...reply, reply: `You are ${api.getPlayerContext().displayName} with ${api.getPlayerContext().coins} coins` }));
    const res = await ask(base, token, '  where is the bakery?  ');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reply: `You are ${account.displayName} with ${STARTING_COINS} coins`, provider: 'fake' });
    expect(assistant.calls).toEqual([{ playerKey: account.id, message: 'where is the bakery?' }]);
  });

  it.each([
    ['rate_limited', 429],
    ['quota_exceeded', 429],
    ['timeout', 504],
    ['unavailable', 503],
    ['bad_request', 400],
    ['unauthorized', 401],
  ] as const)('maps assistant error %s to HTTP %i', async (code, status) => {
    const { base, token } = await aiSetup(async () => ({ error: 'nope', code, retryAfterSec: 7 }));
    const res = await ask(base, token, 'hi');
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: 'nope', code, retryAfterSec: 7 });
    expect(res.headers.get('retry-after')).toBe('7');
  });

  it('turns a crashing assistant into 503 and a hanging one into 504', async () => {
    const crash = await aiSetup(async () => {
      throw new Error('boom');
    });
    const r1 = await ask(crash.base, crash.token, 'hi');
    expect(r1.status).toBe(503);
    expect(((await r1.json()) as AiErrorResponse).code).toBe('unavailable');

    const hang = await aiSetup(() => new Promise(() => undefined), { aiHardTimeoutMs: 50 });
    const r2 = await ask(hang.base, hang.token, 'hi');
    expect(r2.status).toBe(504);
    expect(((await r2.json()) as AiErrorResponse).code).toBe('timeout');
  });

  it('falls back to "unavailable" when no assistant is configured', async () => {
    const dir = tmpDir();
    const srv = createServer({ dataDir: dir, logger: silentLogger });
    const port = await srv.start(0, '127.0.0.1');
    cleanup.push(async () => {
      await srv.stop();
      rmDir(dir);
    });
    const base = `http://127.0.0.1:${port}`;
    const { token } = (await (await login(base, 'alice', 'a@example.com')).json()) as { token: string };
    expect((await ask(base, token, 'hi')).status).toBe(503);
  });
});

describe('static files', () => {
  function makeStatic() {
    const dir = tmpDir('pixels-static-');
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Pixels</title><div id="root"></div>');
    fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log("hi");\n'.repeat(200));
    fs.writeFileSync(path.join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    cleanup.push(() => rmDir(dir));
    return dir;
  }

  it('serves files, the SPA fallback for client routes, and 404 for missing assets', async () => {
    const { base } = await boot({ staticDir: makeStatic() });
    const root = await fetch(base + '/');
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toMatch(/text\/html/);
    expect(root.headers.get('cache-control')).toBe('no-cache');
    expect(await root.text()).toContain('<div id="root">');

    const spa = await fetch(base + '/some/client/route');
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('<div id="root">');

    const js = await fetch(base + '/assets/app-abc123.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect(js.headers.get('cache-control')).toMatch(/immutable/);

    expect((await fetch(base + '/assets/missing.js')).status).toBe(404);
    expect((await fetch(base + '/favicon.svg')).headers.get('content-type')).toBe('image/svg+xml');
    // the API never falls back to the SPA
    expect((await fetch(base + '/api/whatever')).headers.get('content-type')).toMatch(/json/);
  });

  it('compresses large text assets and supports ETag revalidation', async () => {
    const { base } = await boot({ staticDir: makeStatic() });
    const res = await fetch(base + '/assets/app-abc123.js', { headers: { 'accept-encoding': 'gzip' } });
    // fetch transparently decodes; compare the advertised encoding via a raw request
    expect(res.status).toBe(200);
    const raw = await new Promise<{ enc: string | undefined; body: Buffer; etag: string | undefined }>((resolve, reject) => {
      import('node:http').then(({ get }) => {
        get(base + '/assets/app-abc123.js', { headers: { 'accept-encoding': 'gzip' } }, (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => resolve({ enc: r.headers['content-encoding'], body: Buffer.concat(chunks), etag: r.headers.etag }));
        }).on('error', reject);
      });
    });
    expect(raw.enc).toBe('gzip');
    expect(gunzipSync(raw.body).toString()).toContain('console.log("hi");');
    const again = await fetch(base + '/assets/app-abc123.js', { headers: { 'if-none-match': raw.etag! } });
    expect(again.status).toBe(304);
  });

  it('cannot be tricked into serving files outside the static dir', async () => {
    const dir = makeStatic();
    fs.writeFileSync(path.join(path.dirname(dir), 'pixels-secret.txt'), 'secret');
    cleanup.push(() => fs.rmSync(path.join(path.dirname(dir), 'pixels-secret.txt'), { force: true }));
    const { base } = await boot({ staticDir: dir });
    for (const p of ['/../pixels-secret.txt', '/..%2fpixels-secret.txt', '/%2e%2e/pixels-secret.txt', '/assets/..%2f..%2fpixels-secret.txt', '/%00']) {
      const r = await fetch(base + p);
      expect(await r.text(), p).not.toContain('secret');
    }
  });

  it('without a static dir, / answers with a small JSON status', async () => {
    const { base } = await boot();
    const r = await fetch(base + '/');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
  });
});
