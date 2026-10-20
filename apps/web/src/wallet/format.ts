/** Pure helpers for the wallet UI (no wallet libraries: safe to live in the main bundle). */
import { LAMPORTS_PER_SOL } from '@pixels/shared';

export const DEVNET_FAUCET_URL = 'https://faucet.solana.com';

/** "AbCd…WxYz" for a base58 public key (the full key stays available as a tooltip / copy target). */
export function shortenAddress(address: string | null | undefined, chars = 4): string {
  if (!address) return '';
  if (address.length <= chars * 2 + 1) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

/** Exact lamports -> SOL text using integer maths: 10_000_000 -> "0.01", 1_500_000_000 -> "1.5", 123 -> "0.000000123". */
export function formatSol(lamports: number): string {
  if (!Number.isSafeInteger(lamports) || lamports < 0) return '0';
  const whole = Math.floor(lamports / LAMPORTS_PER_SOL);
  const frac = String(lamports % LAMPORTS_PER_SOL).padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

/** The label of the pay button, e.g. "Pay 0.01 SOL (Devnet test)". */
export const payButtonLabel = (lamports: number): string => `Pay ${formatSol(lamports)} SOL (Devnet test)`;
