/** Client-side RPC endpoint choice. Devnet only: anything that does not look like Devnet falls back to the public Devnet node. */
export const DEFAULT_CLIENT_RPC = 'https://api.devnet.solana.com';

export interface ClientRpc {
  url: string;
  /** set when a configured value was rejected */
  warning?: string;
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/**
 * VITE_SOLANA_RPC_URL may point at another Devnet provider (or a loopback mock in tests). The wallet adapter derives
 * the chain from the endpoint text and only recognises "devnet" in it, so a URL without it would be treated as
 * mainnet: reject those instead of risking a wrong-network transaction.
 */
export function resolveClientRpc(configured: string | undefined): ClientRpc {
  const raw = configured?.trim();
  if (!raw) return { url: DEFAULT_CLIENT_RPC };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { url: DEFAULT_CLIENT_RPC, warning: 'VITE_SOLANA_RPC_URL is not a valid URL; using the public Devnet node.' };
  }
  const loopback = LOOPBACK.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    return { url: DEFAULT_CLIENT_RPC, warning: 'VITE_SOLANA_RPC_URL must use https; using the public Devnet node.' };
  }
  if (/mainnet|testnet/i.test(u.hostname + u.pathname)) {
    return { url: DEFAULT_CLIENT_RPC, warning: 'VITE_SOLANA_RPC_URL looks like mainnet/testnet; Devnet only. Using the public Devnet node.' };
  }
  if (!loopback && !/\bdevnet\b/i.test(raw)) {
    return { url: DEFAULT_CLIENT_RPC, warning: 'VITE_SOLANA_RPC_URL must contain "devnet" so wallets use the Devnet chain; using the public Devnet node.' };
  }
  return { url: raw };
}

export function clientRpc(): ClientRpc {
  let configured: string | undefined;
  try {
    configured = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_SOLANA_RPC_URL;
  } catch {
    configured = undefined;
  }
  return resolveClientRpc(configured);
}
