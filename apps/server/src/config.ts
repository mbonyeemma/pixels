import path from 'node:path';
import type { AssistantConfig } from './ai/contract';
import type { LogLevel } from './log';

export interface ServerConfig {
  port: number;
  dataDir: string;
  staticDir: string;
  trustProxy: boolean;
  logLevel: LogLevel;
  ai: AssistantConfig;
}

function int(v: string | undefined, fallback: number, min = 0): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/**
 * Read configuration from environment variables.
 *  - `cwd` anchors DATA_DIR (default ./data); `serverDir` anchors STATIC_DIR (default ../web/dist).
 */
export function loadConfig(env: NodeJS.ProcessEnv, cwd: string, serverDir: string): ServerConfig {
  const provider = (env.AI_PROVIDER ?? 'auto').trim().toLowerCase();
  const level = (env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  return {
    port: int(env.PORT, 8787, 0),
    dataDir: path.resolve(cwd, env.DATA_DIR?.trim() || './data'),
    staticDir: env.STATIC_DIR?.trim() ? path.resolve(cwd, env.STATIC_DIR.trim()) : path.resolve(serverDir, '../web/dist'),
    trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY ?? ''),
    logLevel: (['debug', 'info', 'warn', 'error', 'silent'] as const).find((l) => l === level) ?? 'info',
    ai: {
      provider: provider === 'anthropic' || provider === 'rules' ? provider : 'auto',
      apiKey: apiKey || undefined,
      model: env.AI_MODEL?.trim() || 'claude-haiku-5-5',
      timeoutMs: int(env.AI_TIMEOUT_MS, 15_000, 1),
      dailyLimit: int(env.AI_DAILY_LIMIT, 100, 1),
      ratePerMinute: int(env.AI_RATE_PER_MIN, 10, 1),
      baseUrl: env.AI_BASE_URL?.trim() || undefined,
    },
  };
}
