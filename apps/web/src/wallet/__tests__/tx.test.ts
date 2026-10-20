import { describe, expect, it } from 'vitest';
import type { PayIntentView } from '@pixels/shared';
import { MEMO_PROGRAM_ID, SYSTEM_PROGRAM_ID, buildPaymentTransaction, paymentInstructionPlan, type Web3Like } from '../tx';

const PAYER = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy';
const TREASURY = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const REFERENCE = 'GfXZ8Lgy3e3ZbEx1nYDpAeeTZkUQ3Z5zkkxxiNq3qPKM';
const intent: PayIntentView = {
  intentId: 'abc123',
  itemId: 'genesis_pixel',
  lamports: 10_000_000,
  treasury: TREASURY,
  reference: REFERENCE,
  memo: 'pixels:abc123',
  expiresAt: 0,
  cluster: 'devnet',
};

describe('paymentInstructionPlan', () => {
  const plan = paymentInstructionPlan(intent, PAYER);
  it('is a transfer to the treasury followed by a memo', () => {
    expect(plan.map((p) => p.kind)).toEqual(['transfer', 'memo']);
    expect(plan[0]).toMatchObject({ kind: 'transfer', programId: SYSTEM_PROGRAM_ID, from: PAYER, to: TREASURY, lamports: 10_000_000 });
    expect(plan[1]).toMatchObject({ kind: 'memo', programId: MEMO_PROGRAM_ID, memo: 'pixels:abc123' });
  });
  it('puts the reference on the transfer as a read-only NON-signer account', () => {
    const t = plan[0] as Extract<(typeof plan)[number], { kind: 'transfer' }>;
    expect(t.extraKeys).toEqual([{ pubkey: REFERENCE, isSigner: false, isWritable: false }]);
  });
  it('the memo instruction carries no accounts (so it needs no extra signer)', () => {
    expect((plan[1] as { keys: unknown[] }).keys).toEqual([]);
  });
});

describe('buildPaymentTransaction with a stub web3', () => {
  const calls: string[] = [];
  class PublicKey {
    constructor(readonly key: string) {}
  }
  const stub: Web3Like = {
    PublicKey: PublicKey as unknown as Web3Like['PublicKey'],
    SystemProgram: {
      transfer: ({ fromPubkey, toPubkey, lamports }) => {
        calls.push(`transfer ${(fromPubkey as PublicKey).key}->${(toPubkey as PublicKey).key} ${lamports}`);
        return { keys: [{ pubkey: fromPubkey, isSigner: true, isWritable: true }, { pubkey: toPubkey, isSigner: false, isWritable: true }] };
      },
    },
    Transaction: class {
      instructions: unknown[] = [];
      feePayer: unknown;
      recentBlockhash: string | undefined;
      add(...ix: unknown[]) {
        this.instructions.push(...ix);
        return this;
      }
    } as unknown as Web3Like['Transaction'],
    TransactionInstruction: class {
      constructor(readonly p: unknown) {}
    } as unknown as Web3Like['TransactionInstruction'],
  };

  it('builds transfer(+reference) then memo, sets fee payer and blockhash', () => {
    const tx = buildPaymentTransaction(stub, intent, PAYER, 'BLOCKHASH') as unknown as {
      instructions: { keys?: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]; p?: { programId: PublicKey; data: Uint8Array; keys: unknown[] } }[];
      feePayer: PublicKey;
      recentBlockhash: string;
    };
    expect(calls).toEqual([`transfer ${PAYER}->${TREASURY} 10000000`]);
    expect(tx.instructions).toHaveLength(2);
    const keys = tx.instructions[0].keys!;
    expect(keys).toHaveLength(3);
    expect(keys[2]).toMatchObject({ isSigner: false, isWritable: false });
    expect(keys[2].pubkey.key).toBe(REFERENCE);
    expect(new TextDecoder().decode(tx.instructions[1].p!.data)).toBe('pixels:abc123');
    expect(tx.instructions[1].p!.programId.key).toBe(MEMO_PROGRAM_ID);
    expect(tx.feePayer.key).toBe(PAYER);
    expect(tx.recentBlockhash).toBe('BLOCKHASH');
  });
});

describe('buildPaymentTransaction with the real @solana/web3.js', () => {
  it('compiles to a message where the reference is read-only and not a signer, and only the payer signs', async () => {
    const web3 = await import('@solana/web3.js');
    const payer = web3.Keypair.generate();
    const reference = web3.Keypair.generate().publicKey; // only the public half is ever used
    const treasury = web3.Keypair.generate().publicKey;
    const i: PayIntentView = { ...intent, treasury: treasury.toBase58(), reference: reference.toBase58() };
    const blockhash = web3.Keypair.generate().publicKey.toBase58(); // any 32-byte base58 value is a valid blockhash shape
    const tx = buildPaymentTransaction(web3 as unknown as Web3Like, i, payer.publicKey.toBase58(), blockhash) as InstanceType<typeof web3.Transaction>;
    const msg = tx.compileMessage();
    const idx = (k: { toBase58(): string }) => msg.accountKeys.findIndex((a) => a.toBase58() === k.toBase58());
    expect(idx(reference)).toBeGreaterThan(-1);
    expect(msg.isAccountSigner(idx(reference))).toBe(false);
    expect(msg.isAccountWritable(idx(reference))).toBe(false);
    expect(msg.isAccountSigner(idx(payer.publicKey))).toBe(true);
    expect(msg.isAccountWritable(idx(treasury))).toBe(true);
    expect(msg.header.numRequiredSignatures).toBe(1);
    // a wallet signs with the payer only: the transaction verifies and serialises
    tx.sign(payer);
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.serialize().length).toBeGreaterThan(100);
    const systemIx = msg.instructions[0];
    expect(msg.accountKeys[systemIx.programIdIndex].toBase58()).toBe(SYSTEM_PROGRAM_ID);
    expect(msg.accountKeys[msg.instructions[1].programIdIndex].toBase58()).toBe(MEMO_PROGRAM_ID);
  });
});
