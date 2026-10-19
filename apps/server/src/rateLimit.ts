import type { Clock } from './util';

/** Classic token bucket. Time is passed in so it works with the injectable clock. */
export class TokenBucket {
  private tokens: number;
  private updated: number;

  constructor(
    readonly capacity: number,
    readonly refillPerSec: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.updated = now;
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.updated);
    this.updated = Math.max(this.updated, now);
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.refillPerSec);
  }

  /** Try to take `cost` tokens. */
  take(now: number, cost = 1): boolean {
    this.refill(now);
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  /** Seconds until `cost` tokens are available (0 if available now). */
  waitSec(now: number, cost = 1): number {
    this.refill(now);
    if (this.tokens >= cost) return 0;
    return (cost - this.tokens) / this.refillPerSec;
  }

  /** True when the bucket is full again (safe to forget). */
  idle(now: number): boolean {
    this.refill(now);
    return this.tokens >= this.capacity;
  }
}

/** One token bucket per key (typically a client IP), with periodic pruning of idle keys. */
export class KeyedLimiter {
  private buckets = new Map<string, TokenBucket>();
  private ops = 0;

  constructor(
    private capacity: number,
    private refillPerSec: number,
    private clock: Clock,
    private maxKeys = 20_000,
  ) {}

  take(key: string, cost = 1): boolean {
    const now = this.clock();
    if (++this.ops % 256 === 0 || this.buckets.size > this.maxKeys) this.prune(now);
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys * 1.5) return false; // under a key-flood, fail closed
      b = new TokenBucket(this.capacity, this.refillPerSec, now);
      this.buckets.set(key, b);
    }
    return b.take(now, cost);
  }

  retryAfterSec(key: string): number {
    const b = this.buckets.get(key);
    return b ? Math.ceil(b.waitSec(this.clock())) : 0;
  }

  private prune(now: number): void {
    for (const [k, b] of this.buckets) if (b.idle(now)) this.buckets.delete(k);
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** Sliding-window weighted event counter, used for abuse "strikes". */
export class StrikeWindow {
  private events: { t: number; w: number }[] = [];

  constructor(private windowMs: number) {}

  /** Record an event of the given weight and return the total weight inside the window. */
  add(now: number, weight = 1): number {
    this.prune(now);
    this.events.push({ t: now, w: weight });
    return this.total();
  }

  count(now: number): number {
    this.prune(now);
    return this.total();
  }

  private total(): number {
    let sum = 0;
    for (const e of this.events) sum += e.w;
    return sum;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.events.length && this.events[i].t <= cutoff) i++;
    if (i) this.events.splice(0, i);
  }
}
