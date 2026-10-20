import { z } from 'zod';

/** Request bodies of the wallet / payment endpoints (server-side validation only; the client never imports zod schemas for these). */
export const WalletChallengeRequestSchema = z.object({ publicKey: z.string().min(32).max(44) });
export const WalletVerifyRequestSchema = z.object({
  publicKey: z.string().min(32).max(44),
  /** base58 ed25519 signature (64 bytes) */
  signature: z.string().min(64).max(100),
  /** optional: the nonce from the challenge (lets the server pick the exact challenge) */
  nonce: z.string().min(8).max(64).optional(),
});
export const PayIntentRequestSchema = z.object({ itemId: z.string().min(1).max(40) });
export const PayConfirmRequestSchema = z.object({
  intentId: z.string().min(8).max(64),
  signature: z.string().min(64).max(100),
});
