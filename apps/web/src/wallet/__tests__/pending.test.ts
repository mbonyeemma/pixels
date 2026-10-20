import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPending, pendingPayments, savePending } from '../pending';
import { isPaymentsEnabled } from '../config';

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}
const g = globalThis as { localStorage?: unknown };
let had: unknown;
beforeEach(() => {
  had = g.localStorage;
  g.localStorage = new MemoryStorage();
});
afterEach(() => {
  g.localStorage = had;
});

const p = (over = {}) => ({ accountId: 'a1', intentId: 'i1', itemId: 'genesis_pixel', signature: 's'.repeat(88), at: 1000, ...over });

describe('pending payments (resume after a closed tab)', () => {
  it('stores per account, replaces by intent and clears', () => {
    savePending(p());
    savePending(p({ intentId: 'i2', accountId: 'a2' }));
    savePending(p({ at: 2000 }));
    expect(pendingPayments('a1', 3000).map((x) => [x.intentId, x.at])).toEqual([['i1', 2000]]);
    expect(pendingPayments('a2', 3000)).toHaveLength(1);
    clearPending('i1');
    expect(pendingPayments('a1', 3000)).toEqual([]);
  });
  it('forgets entries older than a day', () => {
    savePending(p());
    expect(pendingPayments('a1', 1000 + 24 * 60 * 60_000 + 1)).toEqual([]);
  });
  it('survives corrupt storage and a missing localStorage', () => {
    (g.localStorage as MemoryStorage).setItem('pixels.pay.pending', '{not json');
    expect(pendingPayments('a1')).toEqual([]);
    g.localStorage = undefined;
    expect(() => savePending(p())).not.toThrow();
    expect(pendingPayments('a1')).toEqual([]);
  });
  it('keeps the list bounded', () => {
    for (let i = 0; i < 30; i++) savePending(p({ intentId: `i${i}`, at: 1000 + i }));
    expect(pendingPayments('a1', 2000).length).toBeLessThanOrEqual(10);
  });
});

describe('isPaymentsEnabled', () => {
  it('needs enabled + devnet + a treasury', () => {
    expect(isPaymentsEnabled(null)).toBe(false);
    expect(isPaymentsEnabled({ enabled: false, cluster: 'devnet' })).toBe(false);
    expect(isPaymentsEnabled({ enabled: true, cluster: 'devnet' })).toBe(false);
    expect(isPaymentsEnabled({ enabled: true, cluster: 'devnet', treasury: 'T' })).toBe(true);
  });
});
