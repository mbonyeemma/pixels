/** Per-player sliding-window rate limiter (in memory, bounded). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 5000,
  ) {}

  /** Records a request when allowed. When not allowed, reports how long until a slot frees up. */
  tryAcquire(key: string, now: number): { ok: true } | { ok: false; retryAfterSec: number } {
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      const wait = list[0] + this.windowMs - now;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(wait / 1000)) };
    }
    list.push(now);
    this.hits.delete(key);
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) this.prune(cutoff);
    return { ok: true };
  }

  private prune(cutoff: number): void {
    for (const [k, v] of this.hits) if (!v.length || v[v.length - 1] <= cutoff) this.hits.delete(k);
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next();
      if (oldest.done) break;
      this.hits.delete(oldest.value);
    }
  }
}

const DAY_MS = 86_400_000;

/** Daily usage cap per player; the day rolls over at UTC midnight. A call is reserved up-front and refunded on failure. */
export class DailyQuota {
  private readonly used = new Map<string, { day: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly maxKeys = 20_000,
  ) {}

  private static dayOf(now: number): number {
    return Math.floor(now / DAY_MS);
  }

  count(key: string, now: number): number {
    const e = this.used.get(key);
    return e && e.day === DailyQuota.dayOf(now) ? e.count : 0;
  }

  remaining(key: string, now: number): number {
    return Math.max(0, this.limit - this.count(key, now));
  }

  /** true when a call was reserved */
  reserve(key: string, now: number): boolean {
    const day = DailyQuota.dayOf(now);
    const count = this.count(key, now);
    if (count >= this.limit) return false;
    this.used.set(key, { day, count: count + 1 });
    if (this.used.size > this.maxKeys) this.prune(day);
    return true;
  }

  refund(key: string, now: number): void {
    const e = this.used.get(key);
    if (e && e.day === DailyQuota.dayOf(now) && e.count > 0) e.count--;
  }

  secondsUntilReset(now: number): number {
    return Math.max(1, Math.ceil(((DailyQuota.dayOf(now) + 1) * DAY_MS - now) / 1000));
  }

  private prune(today: number): void {
    for (const [k, v] of this.used) if (v.day < today) this.used.delete(k);
    while (this.used.size > this.maxKeys) {
      const oldest = this.used.keys().next();
      if (oldest.done) break;
      this.used.delete(oldest.value);
    }
  }
}
