/**
 * Payments whose transaction was sent but not yet confirmed with the server. Stored locally (per account) so a closed
 * tab or a network drop between "wallet approved" and "server verified" can be resumed instead of losing the item.
 * Holds public data only (ids and a transaction signature).
 */
import { safeGet, safeSet } from '../net/storage';

const KEY = 'pixels.pay.pending';
const MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_ENTRIES = 10;

export interface PendingPayment {
  accountId: string;
  intentId: string;
  itemId: string;
  signature: string;
  at: number;
}

function readAll(): PendingPayment[] {
  const raw = safeGet(KEY);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (p): p is PendingPayment =>
        !!p && typeof p.accountId === 'string' && typeof p.intentId === 'string' && typeof p.itemId === 'string' && typeof p.signature === 'string' && typeof p.at === 'number',
    );
  } catch {
    return [];
  }
}

export function pendingPayments(accountId: string, now = Date.now()): PendingPayment[] {
  return readAll().filter((p) => p.accountId === accountId && now - p.at < MAX_AGE_MS);
}

export function savePending(p: PendingPayment): void {
  const rest = readAll().filter((x) => x.intentId !== p.intentId);
  safeSet(KEY, JSON.stringify([...rest, p].slice(-MAX_ENTRIES)));
}

export function clearPending(intentId: string): void {
  safeSet(KEY, JSON.stringify(readAll().filter((x) => x.intentId !== intentId)));
}
