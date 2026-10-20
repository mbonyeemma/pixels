/**
 * Contract test between the browser's payment transaction and the server's on-chain verification: build the exact
 * transaction the client sends (real @solana/web3.js), describe it the way a Solana RPC returns it with
 * `encoding: 'jsonParsed'`, and run it through the server's verifier. If either side changes shape, this fails.
 */
import { describe, expect, it } from 'vitest';
import { Keypair, SystemInstruction, Transaction, type TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { PayIntentView } from '@pixels/shared';
import { verifyPaymentTransaction } from '../../../../server/src/solana/verify';
import type { ParsedTransaction } from '../../../../server/src/solana/types';
import { buildPaymentTransaction, type Web3Like } from '../tx';
import * as web3 from '@solana/web3.js';

function describeAsRpc(tx: Transaction, blockTimeMs: number): ParsedTransaction {
  const msg = tx.compileMessage();
  const keys = msg.accountKeys.map((k, i) => ({ pubkey: k.toBase58(), signer: msg.isAccountSigner(i), writable: msg.isAccountWritable(i), source: 'transaction' }));
  const [transfer, memo] = tx.instructions as [TransactionInstruction, TransactionInstruction];
  const t = SystemInstruction.decodeTransfer(transfer);
  const lamports = Number(t.lamports);
  const idx = (pk: string) => keys.findIndex((k) => k.pubkey === pk);
  const pre = keys.map(() => 3_000_000_000);
  const post = [...pre];
  post[idx(t.fromPubkey.toBase58())] -= lamports + 5000;
  post[idx(t.toPubkey.toBase58())] += lamports;
  return {
    slot: 123_456_789,
    blockTime: Math.floor(blockTimeMs / 1000),
    version: 'legacy',
    meta: { err: null, preBalances: pre, postBalances: post },
    transaction: {
      signatures: [bs58.encode(tx.signature!)],
      message: {
        accountKeys: keys,
        // like a real node: the parsed transfer lists only source/destination/lamports (the reference lives in accountKeys)
        instructions: [
          { program: 'system', programId: transfer.programId.toBase58(), parsed: { type: 'transfer', info: { source: t.fromPubkey.toBase58(), destination: t.toPubkey.toBase58(), lamports } } },
          { program: 'spl-memo', programId: memo.programId.toBase58(), parsed: new TextDecoder().decode(memo.data) },
        ],
      },
    },
  };
}

describe('client transaction vs server verification', () => {
  const payer = Keypair.generate();
  const treasury = Keypair.generate().publicKey;
  const reference = Keypair.generate().publicKey;
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);
  const intent: PayIntentView = {
    intentId: 'f'.repeat(32),
    itemId: 'genesis_pixel',
    lamports: 10_000_000,
    treasury: treasury.toBase58(),
    reference: reference.toBase58(),
    memo: `pixels:${'f'.repeat(32)}`,
    expiresAt: now + 600_000,
    cluster: 'devnet',
  };

  const build = (over: Partial<PayIntentView> = {}) => {
    const tx = buildPaymentTransaction(web3 as unknown as Web3Like, { ...intent, ...over }, payer.publicKey.toBase58(), Keypair.generate().publicKey.toBase58()) as Transaction;
    tx.sign(payer);
    return tx;
  };
  const verify = (tx: Transaction, over: Partial<Parameters<typeof verifyPaymentTransaction>[0]> = {}) =>
    verifyPaymentTransaction({
      tx: describeAsRpc(tx, now),
      signature: bs58.encode(tx.signature!),
      payer: payer.publicKey.toBase58(),
      treasury: intent.treasury,
      reference: intent.reference,
      memo: intent.memo,
      lamports: intent.lamports,
      intentCreatedAt: now - 5000,
      intentExpiresAt: intent.expiresAt,
      now: now + 3000,
      ...over,
    });

  it('the transaction the browser builds is accepted by the server verifier', () => {
    expect(verify(build())).toMatchObject({ ok: true, lamportsReceived: 10_000_000 });
  });

  it('is rejected when it pays a different intent (different reference or memo)', () => {
    expect(verify(build(), { reference: Keypair.generate().publicKey.toBase58() })).toMatchObject({ ok: false, code: 'missing_reference' });
    expect(verify(build(), { memo: 'pixels:other' })).toMatchObject({ ok: false, code: 'memo_mismatch' });
  });

  it('is rejected when the price asked by the server is higher than what was sent', () => {
    expect(verify(build(), { lamports: 10_000_001 })).toMatchObject({ ok: false, code: 'amount_too_low' });
  });
});
