import { MEMO_PROGRAM_IDS, SYSTEM_PROGRAM_ID, type ParsedAccountKey, type ParsedInstruction, type ParsedTransaction } from './types';

/** Allowed clock drift between a validator's block time and this server. */
export const BLOCK_TIME_SKEW_MS = 2 * 60_000;

export type VerifyFailureCode =
  | 'tx_mismatch'
  | 'tx_failed'
  | 'bad_time'
  | 'wrong_sender'
  | 'missing_reference'
  | 'wrong_recipient'
  | 'amount_too_low'
  | 'memo_mismatch'
  | 'balance_mismatch';

export type VerifyResult =
  | { ok: true; slot: number; blockTimeMs: number; lamportsReceived: number }
  | { ok: false; code: VerifyFailureCode; error: string };

export interface VerifyInput {
  tx: ParsedTransaction;
  signature: string;
  payer: string;
  treasury: string;
  reference: string;
  memo: string;
  lamports: number;
  intentCreatedAt: number;
  intentExpiresAt: number;
  now: number;
}

const fail = (code: VerifyFailureCode, error: string): VerifyResult => ({ ok: false, code, error });

function normaliseKeys(keys: (ParsedAccountKey | string)[] | undefined): ParsedAccountKey[] {
  if (!Array.isArray(keys)) return [];
  return keys.map((k) => (typeof k === 'string' ? { pubkey: k, signer: false, writable: false } : k)).filter((k) => !!k && typeof k.pubkey === 'string');
}

/** `info.lamports` of a parsed system transfer as a safe integer (the RPC sends a JSON number), else null. */
function lamportsOf(ix: ParsedInstruction): number | null {
  const parsed = ix.parsed as { type?: unknown; info?: { lamports?: unknown; source?: unknown; destination?: unknown } } | undefined;
  const l = parsed?.info?.lamports;
  if (typeof l === 'number' && Number.isSafeInteger(l) && l >= 0) return l;
  if (typeof l === 'string' && /^\d{1,15}$/.test(l)) return Number(l);
  return null;
}

/**
 * Decide whether an on-chain transaction pays this intent. Pure: no I/O, no clock besides `now`. Every rule fails
 * closed. The caller is responsible for the replay ledger, intent ownership/expiry and the cluster guard.
 */
export function verifyPaymentTransaction(input: VerifyInput): VerifyResult {
  const { tx, signature, payer, treasury, reference, memo, lamports } = input;
  if (!tx || typeof tx !== 'object' || !tx.transaction?.message) return fail('tx_mismatch', 'The transaction could not be read.');

  // 1. it is the transaction we asked about
  if (!Array.isArray(tx.transaction.signatures) || tx.transaction.signatures[0] !== signature) {
    return fail('tx_mismatch', 'The transaction returned by the network does not match the signature.');
  }

  // 2. it succeeded
  if (!tx.meta || tx.meta.err !== null) return fail('tx_failed', 'The transaction did not succeed on the network.');

  // 3. slot and block time are sane, and the payment was made inside the intent's window
  if (!Number.isSafeInteger(tx.slot) || tx.slot <= 0) return fail('bad_time', 'The transaction has no valid slot.');
  if (typeof tx.blockTime !== 'number' || !Number.isFinite(tx.blockTime) || tx.blockTime <= 0) return fail('bad_time', 'The transaction has no block time yet.');
  const blockTimeMs = tx.blockTime * 1000;
  if (blockTimeMs < input.intentCreatedAt - BLOCK_TIME_SKEW_MS) return fail('bad_time', 'That transaction is older than this payment request.');
  if (blockTimeMs > input.intentExpiresAt + BLOCK_TIME_SKEW_MS) return fail('bad_time', 'That transaction was made after this payment request expired.');
  if (blockTimeMs > input.now + BLOCK_TIME_SKEW_MS) return fail('bad_time', 'The transaction block time is in the future.');

  const keys = normaliseKeys(tx.transaction.message.accountKeys);
  const instructions = Array.isArray(tx.transaction.message.instructions) ? tx.transaction.message.instructions : [];

  // 4. the sender is the player's linked wallet and really signed
  if (payer === treasury) return fail('wrong_sender', 'The paying wallet cannot be the treasury itself.');
  const payerKey = keys.find((k) => k.pubkey === payer);
  if (!payerKey || !payerKey.signer) return fail('wrong_sender', 'The transaction was not signed by your linked wallet.');

  // 5. it carries this intent's one-time reference account (never a signer)
  const refKey = keys.find((k) => k.pubkey === reference);
  if (!refKey || refKey.signer) return fail('missing_reference', 'The transaction does not contain this payment request\'s reference.');

  // 6. a system transfer payer -> treasury of at least the price
  let best: number | null = null;
  let toTreasuryFromOthers = false;
  for (const ix of instructions) {
    if (ix.programId !== SYSTEM_PROGRAM_ID) continue;
    const parsed = ix.parsed as { type?: unknown; info?: { source?: unknown; destination?: unknown } } | undefined;
    if (parsed?.type !== 'transfer' || !parsed.info) continue;
    const amount = lamportsOf(ix);
    if (amount === null) continue;
    if (parsed.info.destination === treasury) {
      if (parsed.info.source === payer) best = Math.max(best ?? 0, amount);
      else toTreasuryFromOthers = true;
    }
  }
  if (best === null) {
    return toTreasuryFromOthers
      ? fail('wrong_sender', 'The treasury was paid by a different wallet than your linked wallet.')
      : fail('wrong_recipient', 'The transaction does not pay the Pixels treasury.');
  }
  if (best < lamports) return fail('amount_too_low', `The transaction paid ${best} lamports but ${lamports} are required.`);

  // 7. a Pixels memo, if present, names this intent (informational, the reference is what binds the payment)
  for (const ix of instructions) {
    if (!MEMO_PROGRAM_IDS.includes(ix.programId)) continue;
    const text = typeof ix.parsed === 'string' ? ix.parsed : null;
    if (text && text.startsWith('pixels:') && text !== memo) return fail('memo_mismatch', 'The transaction memo names a different payment request.');
  }

  // 8. belt and braces: the treasury balance really went up by at least the price
  const idx = keys.findIndex((k) => k.pubkey === treasury);
  const pre = tx.meta.preBalances?.[idx];
  const post = tx.meta.postBalances?.[idx];
  if (idx < 0 || typeof pre !== 'number' || typeof post !== 'number') return fail('balance_mismatch', 'The treasury balance change could not be verified.');
  const received = post - pre;
  if (received < lamports) return fail('balance_mismatch', 'The treasury balance did not increase by the required amount.');

  return { ok: true, slot: tx.slot, blockTimeMs, lamportsReceived: received };
}
