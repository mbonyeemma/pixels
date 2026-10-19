export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
/** Field names that must never reach the logs, whatever a caller passes. */
const REDACT = /^(email|token|authorization|password|secret|apikey|api_key|key)$/i;

function fmtValue(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v instanceof Error) return JSON.stringify(v.message);
  if (typeof v === 'string') return /^[\w.:@/#+-]+$/.test(v) ? v : JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '[unserialisable]';
  }
}

export interface LogSink {
  log(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

/** Concise single-line structured logs: `2026-01-01T00:00:00.000Z INFO login account=ab12 new=true`. */
export function createLogger(level: LogLevel = 'info', sink: LogSink = console): Logger {
  const min = ORDER[level];
  const emit = (lvl: Exclude<LogLevel, 'silent'>, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    let line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}`;
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        line += ` ${k}=${REDACT.test(k) ? '[redacted]' : fmtValue(v)}`;
      }
    }
    if (lvl === 'error') sink.error(line);
    else if (lvl === 'warn') sink.warn(line);
    else sink.log(line);
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
