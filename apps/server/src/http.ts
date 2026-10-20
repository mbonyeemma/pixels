import type { IncomingMessage, ServerResponse } from 'node:http';
import { AiRequestSchema, LoginRequestSchema, type AiErrorResponse, type AiResponse } from '@pixels/shared';
import type { Accounts } from './accounts';
import type { Assistant } from './ai/contract';
import { createAiGameApi, type AiApiDeps } from './aiGameApi';
import type { Database } from './db';
import type { Game } from './game';
import type { Logger } from './log';
import { KeyedLimiter } from './rateLimit';
import type { SolanaRoutes } from './solana/routes';
import { createStaticHandler } from './static';
import type { Clock } from './util';

export const MAX_BODY_BYTES = 10 * 1024;

export interface HttpDeps {
  db: Database;
  accounts: Accounts;
  game: Game;
  assistant: Assistant;
  aiApiDeps: AiApiDeps;
  /** optional Solana Devnet wallet/payment routes (GET /api/config is always answered, even when payments are off) */
  solana?: SolanaRoutes;
  clock: Clock;
  log: Logger;
  startedAt: number;
  staticDir: string | null;
  trustProxy: boolean;
  /** login attempts allowed per IP: burst, then refill per minute */
  loginBurst?: number;
  loginPerMinute?: number;
  /** hard ceiling on one assistant call, a bit above the assistant's own timeout */
  aiHardTimeoutMs?: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

const AI_STATUS: Record<AiErrorResponse['code'], number> = {
  rate_limited: 429,
  quota_exceeded: 429,
  timeout: 504,
  unavailable: 503,
  bad_request: 400,
  unauthorized: 401,
};

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '600',
};
const BASE_HEADERS: Record<string, string> = {
  ...CORS,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function sendJson(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string | number>): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(data);
}

/** Read and parse a JSON body, enforcing the size limit while streaming. */
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      req.resume();
      return reject(new HttpError(413, 'Request body too large.'));
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new HttpError(413, 'Request body too large.'));
        req.resume(); // drain and discard the rest
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      if (size === 0) return reject(new HttpError(400, 'Request body must be JSON.'));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Request body must be valid JSON.'));
      }
    });
    req.on('error', () => {
      if (!failed) reject(new HttpError(400, 'Could not read the request body.'));
    });
  });
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

const trimField = (v: unknown) => (typeof v === 'string' ? v.trim() : v);

export function createHttpHandler(deps: HttpDeps) {
  const loginLimiter = new KeyedLimiter(deps.loginBurst ?? 10, (deps.loginPerMinute ?? 10) / 60, deps.clock);
  const aiLimiter = new KeyedLimiter(20, 30 / 60, deps.clock);
  const staticHandler = deps.staticDir ? createStaticHandler(deps.staticDir) : null;
  const aiHardTimeout = deps.aiHardTimeoutMs ?? 20_000;

  async function login(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    if (!loginLimiter.take(ip)) {
      const retry = Math.max(1, loginLimiter.retryAfterSec(ip));
      return sendJson(res, 429, { error: 'Too many login attempts. Please wait a moment and try again.', code: 'rate_limited', retryAfterSec: retry }, { 'Retry-After': retry });
    }
    const body = await readJson(req);
    const obj = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const parsed = LoginRequestSchema.safeParse({ username: trimField(obj.username), email: trimField(obj.email) });
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Invalid login details.';
      return sendJson(res, 400, { error: message, code: 'bad_request' });
    }
    const result = deps.accounts.login(parsed.data.username, parsed.data.email);
    if (!result.ok) return sendJson(res, result.status, { error: result.error });
    sendJson(res, 200, { token: result.token, account: deps.accounts.view(result.account) });
  }

  function me(req: IncomingMessage, res: ServerResponse): void {
    const account = deps.accounts.authenticateHeader(req.headers.authorization);
    if (!account) return sendJson(res, 401, { error: 'Not signed in.', code: 'unauthorized' });
    sendJson(res, 200, deps.accounts.view(account));
  }

  function health(res: ServerResponse): void {
    const ai = deps.assistant.describe();
    sendJson(res, 200, {
      ok: true,
      players: deps.game.playerCount,
      uptime: Math.round((deps.clock() - deps.startedAt) / 1000),
      ai: { provider: ai.provider, model: ai.model },
    });
  }

  async function ai(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    const account = deps.accounts.authenticateHeader(req.headers.authorization);
    if (!account) return sendJson(res, 401, { error: 'Not signed in.', code: 'unauthorized' } satisfies AiErrorResponse);
    if (!aiLimiter.take(ip)) {
      const retry = Math.max(1, aiLimiter.retryAfterSec(ip));
      return sendJson(res, 429, { error: 'Too many requests. Please slow down.', code: 'rate_limited', retryAfterSec: retry } satisfies AiErrorResponse, { 'Retry-After': retry });
    }
    const body = await readJson(req);
    const parsed = AiRequestSchema.safeParse(body);
    if (!parsed.success) {
      return sendJson(res, 400, { error: 'Send a message between 1 and 300 characters.', code: 'bad_request' } satisfies AiErrorResponse);
    }
    const api = createAiGameApi(deps.aiApiDeps, account.id);
    let timer: NodeJS.Timeout | undefined;
    let result: AiResponse | AiErrorResponse;
    try {
      result = await Promise.race([
        deps.assistant.handle({ playerKey: account.id, message: parsed.data.message, api, now: deps.clock() }),
        new Promise<AiErrorResponse>((resolve) => {
          timer = setTimeout(() => resolve({ error: 'The assistant took too long to answer.', code: 'timeout' }), aiHardTimeout);
        }),
      ]);
    } catch (err) {
      deps.log.error('assistant crashed', { account: account.id, err });
      result = { error: 'The assistant is unavailable right now.', code: 'unavailable' };
    } finally {
      if (timer) clearTimeout(timer);
    }
    if ('error' in result && 'code' in result) {
      const status = AI_STATUS[result.code] ?? 503;
      const extra = result.retryAfterSec ? { 'Retry-After': Math.max(1, Math.ceil(result.retryAfterSec)) } : undefined;
      return sendJson(res, status, result, extra);
    }
    sendJson(res, 200, result);
  }

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = clientIp(req, deps.trustProxy);
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return sendJson(res, 400, { error: 'Bad request.' });
    }
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, BASE_HEADERS);
        res.end();
        return;
      }
      if (pathname.startsWith('/api/')) {
        const route = `${req.method} ${pathname.replace(/\/+$/, '')}`;
        switch (route) {
          case 'POST /api/login':
            return await login(req, res, ip);
          case 'GET /api/me':
            return me(req, res);
          case 'GET /api/health':
            return health(res);
          case 'POST /api/ai':
            return await ai(req, res, ip);
          default: {
            const clean = pathname.replace(/\/+$/, '');
            if (deps.solana?.handles(route)) {
              const r = await deps.solana.handle(route, {
                ip,
                authorization: req.headers.authorization,
                readBody: () => readJson(req),
              });
              return sendJson(res, r.status, r.body, r.headers);
            }
            const known = ['/api/login', '/api/me', '/api/health', '/api/ai', ...(deps.solana?.paths ?? [])].includes(clean);
            return sendJson(res, known ? 405 : 404, { error: known ? 'Method not allowed.' : 'Not found.' });
          }
        }
      }
      if (pathname === '/ws') {
        // plain HTTP request to the websocket path
        return sendJson(res, 426, { error: 'Use a WebSocket connection.' });
      }
      if (staticHandler && (await staticHandler(req, res, pathname))) return;
      if (!res.headersSent) {
        if (staticHandler === null && pathname === '/') {
          return sendJson(res, 200, { name: 'pixels-server', ok: true });
        }
        sendJson(res, 404, { error: 'Not found.' });
      }
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) {
          sendJson(res, err.status, { error: err.message, code: err.code ?? 'bad_request' }, err.status === 413 ? { Connection: 'close' } : undefined);
        }
        return;
      }
      deps.log.error('http handler error', { path: pathname, err });
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error.' });
      else res.end();
    }
  };
}
