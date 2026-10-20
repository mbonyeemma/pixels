import bs58 from 'bs58';

/** Decode base58, returning null (never throwing) for invalid input. */
export function decodeBase58(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > 128) return null;
  try {
    return bs58.decode(s);
  } catch {
    return null;
  }
}

export const encodeBase58 = (bytes: Uint8Array): string => bs58.encode(bytes);

/** A Solana public key: base58 of exactly 32 bytes. */
export function decodePublicKey(s: unknown): Uint8Array | null {
  const b = decodeBase58(s);
  return b && b.length === 32 ? b : null;
}

/** A transaction signature: base58 of exactly 64 bytes. */
export function isValidSignature(s: unknown): s is string {
  const b = decodeBase58(s);
  return !!b && b.length === 64;
}
