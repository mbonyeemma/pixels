import { describe, expect, it } from 'vitest';
import { RECOMMENDED_WALLETS, describeWalletError } from '../walletErrors';
import { DEFAULT_CLIENT_RPC, resolveClientRpc } from '../cluster';

const err = (name: string, message = '', extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { name, ...extra });

describe('describeWalletError', () => {
  it('user rejected -> says nothing was sent or charged', () => {
    for (const e of [err('WalletSignMessageError', 'User rejected the request.'), err('WalletConnectionError', 'The user denied the request'), { code: 4001, message: '' }, err('WalletSendTransactionError', 'Transaction cancelled')]) {
      const i = describeWalletError(e);
      expect(i.kind).toBe('rejected');
      expect(i.message).toMatch(/nothing was sent/i);
    }
  });
  it('rejection wrapped in the adapter error', () => {
    expect(describeWalletError(err('WalletSendTransactionError', '', { error: { message: 'User rejected the request.' } })).kind).toBe('rejected');
  });
  it('no wallet / not ready -> install hint', () => {
    expect(describeWalletError(err('WalletNotReadyError')).kind).toBe('not_installed');
  });
  it('a bare send failure is treated as a wrong network and explains how to switch to Devnet', () => {
    const i = describeWalletError(err('WalletSendTransactionError', ''));
    expect(i.kind).toBe('wrong_network');
    expect(i.message).toMatch(/Devnet/);
  });
  it('mentions of network / blockhash / chain are wrong-network hints', () => {
    expect(describeWalletError(err('Error', 'Blockhash not found')).kind).toBe('wrong_network');
    expect(describeWalletError(err('Error', 'unsupported chain solana:devnet')).kind).not.toBe('rejected');
  });
  it('unsupported wallets', () => {
    expect(describeWalletError(err('WalletAccountError')).kind).toBe('unsupported');
  });
  it('unknown problems keep a short slice of the wallet message, never throw', () => {
    const i = describeWalletError(err('Error', 'x'.repeat(500)));
    expect(i.kind).toBe('unknown');
    expect(i.message.length).toBeLessThan(220);
    expect(describeWalletError(null).kind).toBe('unknown');
    expect(describeWalletError('boom').kind).toBe('unknown');
  });
});

describe('recommended wallets', () => {
  it('lists Phantom, Solflare and Backpack with https links', () => {
    expect(RECOMMENDED_WALLETS.map((w) => w.name)).toEqual(['Phantom', 'Solflare', 'Backpack']);
    for (const w of RECOMMENDED_WALLETS) expect(w.url).toMatch(/^https:\/\//);
  });
});

describe('resolveClientRpc (devnet only)', () => {
  it('defaults to the public devnet node', () => {
    expect(resolveClientRpc(undefined).url).toBe(DEFAULT_CLIENT_RPC);
    expect(resolveClientRpc('  ').url).toBe(DEFAULT_CLIENT_RPC);
    expect(DEFAULT_CLIENT_RPC).toBe('https://api.devnet.solana.com');
  });
  it('accepts other devnet providers and loopback mocks', () => {
    expect(resolveClientRpc('https://devnet.helius-rpc.com/?api-key=abc')).toEqual({ url: 'https://devnet.helius-rpc.com/?api-key=abc' });
    expect(resolveClientRpc('http://127.0.0.1:9999').url).toBe('http://127.0.0.1:9999');
    expect(resolveClientRpc('http://localhost:8899').url).toBe('http://localhost:8899');
  });
  it('falls back (with a warning) for anything that is not clearly devnet', () => {
    for (const bad of ['https://api.mainnet-beta.solana.com', 'https://api.testnet.solana.com', 'https://my-rpc.example.com', 'http://example.com/devnet', 'not a url', 'ftp://devnet.example.com']) {
      const r = resolveClientRpc(bad);
      expect(r.url, bad).toBe(DEFAULT_CLIENT_RPC);
      expect(r.warning, bad).toBeTruthy();
    }
  });
});
