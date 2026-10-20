/**
 * The payment transaction, built from a server-issued PayIntentView.
 *
 * `paymentInstructionPlan` is pure data (unit-testable without any Solana library). `buildPaymentTransaction`
 * turns the plan into a web3.js Transaction using the module passed in (the real one at runtime, a stub in tests).
 * Only the transfer to the treasury moves value; the reference is a read-only, non-signer account key on the same
 * instruction so the server can find the transaction; the memo is informational.
 */
import type { PayIntentView } from '@pixels/shared';

export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

export interface KeyMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}
export type InstructionPlan =
  | { kind: 'transfer'; programId: string; from: string; to: string; lamports: number; extraKeys: KeyMeta[] }
  | { kind: 'memo'; programId: string; memo: string; keys: KeyMeta[] };

export function paymentInstructionPlan(intent: Pick<PayIntentView, 'treasury' | 'reference' | 'lamports' | 'memo'>, payer: string): InstructionPlan[] {
  return [
    {
      kind: 'transfer',
      programId: SYSTEM_PROGRAM_ID,
      from: payer,
      to: intent.treasury,
      lamports: intent.lamports,
      extraKeys: [{ pubkey: intent.reference, isSigner: false, isWritable: false }],
    },
    { kind: 'memo', programId: MEMO_PROGRAM_ID, memo: intent.memo, keys: [] },
  ];
}

/** The slice of @solana/web3.js we use; tests pass a stub with the same shape. */
export interface Web3Like {
  PublicKey: new (key: string) => unknown;
  SystemProgram: { transfer(p: { fromPubkey: unknown; toPubkey: unknown; lamports: number }): { keys: { pubkey: unknown; isSigner: boolean; isWritable: boolean }[] } };
  Transaction: new () => { add(...ix: unknown[]): unknown; feePayer?: unknown; recentBlockhash?: string };
  TransactionInstruction: new (p: { keys: { pubkey: unknown; isSigner: boolean; isWritable: boolean }[]; programId: unknown; data: Uint8Array }) => unknown;
}

export function buildPaymentTransaction(web3: Web3Like, intent: PayIntentView, payer: string, recentBlockhash: string) {
  const pk = (k: string) => new web3.PublicKey(k);
  const tx = new web3.Transaction();
  for (const step of paymentInstructionPlan(intent, payer)) {
    if (step.kind === 'transfer') {
      const ix = web3.SystemProgram.transfer({ fromPubkey: pk(step.from), toPubkey: pk(step.to), lamports: step.lamports });
      for (const k of step.extraKeys) ix.keys.push({ pubkey: pk(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable });
      tx.add(ix);
    } else {
      tx.add(new web3.TransactionInstruction({ keys: step.keys.map((k) => ({ pubkey: pk(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })), programId: pk(step.programId), data: new TextEncoder().encode(step.memo) }));
    }
  }
  tx.feePayer = pk(payer);
  tx.recentBlockhash = recentBlockhash;
  return tx;
}
