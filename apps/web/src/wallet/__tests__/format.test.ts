import { describe, expect, it } from 'vitest';
import { DEVNET_FAUCET_URL, formatSol, payButtonLabel, shortenAddress } from '../format';

describe('shortenAddress', () => {
  const key = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy';
  it('keeps the first and last 4 characters', () => {
    expect(shortenAddress(key)).toBe('DRpb…21hy');
    expect(shortenAddress(key, 6)).toBe('DRpbCB…km21hy');
  });
  it('leaves short strings and empty values alone', () => {
    expect(shortenAddress('abcd')).toBe('abcd');
    expect(shortenAddress('')).toBe('');
    expect(shortenAddress(null)).toBe('');
    expect(shortenAddress(undefined)).toBe('');
    expect(shortenAddress('123456789')).toBe('123456789'); // 9 chars: no shortening gain
  });
});

describe('formatSol (exact integer maths)', () => {
  it('formats the catalogue prices', () => {
    expect(formatSol(10_000_000)).toBe('0.01');
    expect(formatSol(5_000_000)).toBe('0.005');
    expect(formatSol(2_000_000)).toBe('0.002');
  });
  it('handles whole numbers, fractions and the smallest unit', () => {
    expect(formatSol(0)).toBe('0');
    expect(formatSol(1_000_000_000)).toBe('1');
    expect(formatSol(1_500_000_000)).toBe('1.5');
    expect(formatSol(123)).toBe('0.000000123');
    expect(formatSol(12_345_678_901)).toBe('12.345678901');
  });
  it('never prints garbage for invalid input', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) expect(formatSol(bad)).toBe('0');
  });
});

describe('payButtonLabel', () => {
  it('matches the product wording', () => {
    expect(payButtonLabel(10_000_000)).toBe('Pay 0.01 SOL (Devnet test)');
    expect(payButtonLabel(2_000_000)).toBe('Pay 0.002 SOL (Devnet test)');
  });
  it('points at the official faucet', () => {
    expect(DEVNET_FAUCET_URL).toBe('https://faucet.solana.com');
  });
});
