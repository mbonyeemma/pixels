export const RECONNECT_MIN_MS = 500;
export const RECONNECT_MAX_MS = 10_000;

/**
 * Exponential backoff with jitter: 500ms, 1s, 2s, 4s, 8s, 10s, 10s ... each scaled by a random factor in
 * [0.8, 1.2] and never above RECONNECT_MAX_MS. `attempt` is zero-based.
 */
export function reconnectDelay(attempt: number, rand: () => number = Math.random): number {
  const a = Math.max(0, Math.floor(attempt));
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(a, 16));
  const jitter = 0.8 + 0.4 * rand();
  return Math.round(Math.min(RECONNECT_MAX_MS, Math.max(RECONNECT_MIN_MS * 0.5, base * jitter)));
}
