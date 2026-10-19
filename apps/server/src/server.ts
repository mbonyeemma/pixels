import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { Accounts } from './accounts';
import type { Assistant } from './ai/contract';
import { Database } from './db';
import { CloseCode, Game, type PlayerSession, type Transport } from './game';
import { clientIp, createHttpHandler } from './http';
import { silentLogger, type Logger } from './log';
import { MissionEngine } from './missions';
import { Shop, type PaymentProvider } from './shop';
import { systemClock, type Clock } from './util';

export interface ServerOptions {
  /** directory for db.json (created if missing) */
  dataDir: string;
  /** built web app to serve (SPA fallback); null/undefined = API + websocket only */
  staticDir?: string | null;
  /** the AI assistant; a stub that answers `unavailable` is used when omitted */
  assistant?: Assistant;
  /** injectable clock (ms); defaults to Date.now */
  now?: Clock;
  logger?: Logger;
  /** trust X-Forwarded-For for per-IP limits (only behind a reverse proxy) */
  trustProxy?: boolean;
  /** set false to skip the snapshot/housekeeping/heartbeat timers (tests drive game.tick() etc. manually) */
  timers?: boolean;
  maxPlayers?: number;
  maxConnectionsPerIp?: number;
  heartbeatMs?: number;
  dbDebounceMs?: number;
  loginBurst?: number;
  loginPerMinute?: number;
  aiHardTimeoutMs?: number;
  /** payment seam for the shop; defaults to in-game coins */
  paymentProvider?: PaymentProvider;
}

export interface GameServer {
  /** listen (port 0 = pick a free one); resolves with the bound port */
  start(port?: number, host?: string): Promise<number>;
  /** disconnect everyone, close sockets and flush the database */
  stop(): Promise<void>;
  readonly httpServer: Server;
  readonly port: number;
  readonly game: Game;
  readonly db: Database;
  readonly accounts: Accounts;
  readonly missions: MissionEngine;
  readonly shop: Shop;
  readonly wss: WebSocketServer;
}

const unavailableAssistant: Assistant = {
  async handle() {
    return { error: 'The assistant is not available on this server.', code: 'unavailable' };
  },
  describe: () => ({ provider: 'none', model: null }),
};

/** Adapts a `ws` socket to the game's Transport. */
class WsTransport implements Transport {
  constructor(private readonly ws: WebSocket) {}
  send(data: string, opts?: { droppable?: boolean }): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    // a backed-up socket skips droppable frames (snapshots) instead of growing its buffer without bound
    if (opts?.droppable && this.ws.bufferedAmount > 512 * 1024) return;
    this.ws.send(data);
  }
  close(code: number, reason?: string): void {
    try {
      this.ws.close(code, reason);
    } catch {
      this.ws.terminate();
    }
  }
  terminate(): void {
    this.ws.terminate();
  }
  ping(): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.ping();
  }
}

const toBuffer = (d: RawData): Buffer => (Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d));

export function createServer(options: ServerOptions): GameServer {
  const clock = options.now ?? systemClock;
  const log = options.logger ?? silentLogger;
  const startedAt = clock();
  const assistant = options.assistant ?? unavailableAssistant;

  const db = new Database({ dir: options.dataDir, clock, logger: log, debounceMs: options.dbDebounceMs });
  db.load();
  const accounts = new Accounts(db, clock, log);
  const shop = new Shop(db, log, options.paymentProvider);
  const missions = new MissionEngine({
    db,
    clock,
    log,
    getPosition: (id) => game.getPlayerPosition(id),
    notify: (id, msg) => game.sendTo(id, msg),
  });
  const game: Game = new Game(
    { db, accounts, missions, shop },
    { clock, log, maxPlayers: options.maxPlayers, heartbeatMs: options.heartbeatMs, maxConnectionsPerIp: options.maxConnectionsPerIp },
  );

  const trustProxy = options.trustProxy ?? false;
  const handler = createHttpHandler({
    db,
    accounts,
    game,
    assistant,
    aiApiDeps: { db, game, missions, shop },
    clock,
    log,
    startedAt,
    staticDir: options.staticDir ?? null,
    trustProxy,
    loginBurst: options.loginBurst,
    loginPerMinute: options.loginPerMinute,
    aiHardTimeoutMs: options.aiHardTimeoutMs,
  });
  const httpServer = createHttpServer((req, res) => {
    handler(req, res).catch((err) => {
      log.error('unhandled http error', { err });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 4096, perMessageDeflate: false });
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const ip = clientIp(req, trustProxy);
    if (!game.connectLimiter.take(ip)) {
      ws.close(CloseCode.TOO_MANY_CONNECTIONS, 'too many connection attempts');
      return;
    }
    let token: string | null = null;
    try {
      token = new URL(req.url ?? '', 'http://localhost').searchParams.get('token');
    } catch {
      /* treated as an invalid token */
    }
    const account = accounts.authenticate(token);
    if (!account) {
      ws.close(CloseCode.INVALID_TOKEN, 'invalid token');
      return;
    }
    const session: PlayerSession | null = game.connect(account, new WsTransport(ws), ip);
    if (!session) return;
    ws.on('message', (data: RawData, isBinary: boolean) => {
      void game.receive(session, isBinary ? Buffer.alloc(0) : toBuffer(data), isBinary);
    });
    ws.on('pong', () => game.markAlive(session));
    ws.on('close', () => game.disconnect(session, 'socket closed'));
    ws.on('error', (err: Error) => {
      log.warn('socket error', { account: session.id, err });
      ws.terminate();
    });
  });
  wss.on('error', (err: Error) => log.error('websocket server error', { err }));

  let stopped = false;
  const server: GameServer = {
    httpServer,
    wss,
    game,
    db,
    accounts,
    missions,
    shop,
    get port() {
      const a = httpServer.address() as AddressInfo | string | null;
      return a && typeof a === 'object' ? a.port : 0;
    },
    start(port = 0, host?: string) {
      return new Promise<number>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        httpServer.once('error', onError);
        const onListening = () => {
          httpServer.off('error', onError);
          if (options.timers !== false) game.start();
          resolve(server.port);
        };
        if (host) httpServer.listen(port, host, onListening);
        else httpServer.listen(port, onListening);
      });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      game.shutdown();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => {
        if (!httpServer.listening) return resolve();
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
      await db.close();
    },
  };
  return server;
}
