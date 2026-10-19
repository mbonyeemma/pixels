/** Short in-memory conversation memory per player: last N turns, TTL, bounded number of players. */
export interface Turn {
  user: string;
  assistant: string;
}

export class ConversationMemory {
  private readonly map = new Map<string, { turns: Turn[]; updatedAt: number }>();

  constructor(
    private readonly maxTurns = 6,
    private readonly ttlMs = 30 * 60_000,
    private readonly maxPlayers = 2000,
  ) {}

  get(key: string, now: number): Turn[] {
    const e = this.map.get(key);
    if (!e) return [];
    if (now - e.updatedAt > this.ttlMs) {
      this.map.delete(key);
      return [];
    }
    return e.turns.slice();
  }

  add(key: string, turn: Turn, now: number): void {
    const prev = this.get(key, now);
    prev.push(turn);
    const turns = prev.slice(-this.maxTurns);
    this.map.delete(key); // re-insert so Map order is least-recently-updated first
    this.map.set(key, { turns, updatedAt: now });
    if (this.map.size > this.maxPlayers) this.evict(now);
  }

  private evict(now: number): void {
    for (const [k, v] of this.map) if (now - v.updatedAt > this.ttlMs) this.map.delete(k);
    while (this.map.size > this.maxPlayers) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  get size(): number {
    return this.map.size;
  }
}
