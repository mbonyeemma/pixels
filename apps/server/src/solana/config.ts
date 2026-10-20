import { DISABLED_PAYMENTS, type PaymentsConfig } from './types';
import { decodeBase58 } from './base58';

export class PaymentsConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid payments configuration: ${problems.join(' ')}`);
    this.name = 'PaymentsConfigError';
  }
}

const TRUE_RE = /^(1|true|yes|on)$/i;
export const DEFAULT_DEVNET_RPC = 'https://api.devnet.solana.com';

/**
 * RPC URL guard (first line of defence; the genesis-hash check at runtime is the real one).
 * Must be https (plain http only for loopback, used by local mock/test RPCs) and must not look like mainnet/testnet.
 * Returns an error message, or null when the URL is acceptable.
 */
export function checkRpcUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'SOLANA_RPC_URL is not a valid URL.';
  }
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return 'SOLANA_RPC_URL must use https (http is only allowed for localhost).';
  if (/mainnet|testnet/i.test(u.hostname + u.pathname)) {
    return 'SOLANA_RPC_URL looks like a mainnet or testnet endpoint. Only Solana Devnet is supported.';
  }
  return null;
}

/** A value that decodes to 64 bytes is a secret (keypair) key: refuse it loudly instead of ever holding it. */
function looksLikeSecret(value: string): boolean {
  const b = decodeBase58(value);
  if (b && b.length === 64) return true;
  return /^\s*\[\s*\d+(\s*,\s*\d+){31,}\s*\]\s*$/.test(value); // solana-keygen JSON byte array
}

/**
 * Read payments settings from the environment. Disabled (the default) needs nothing. Enabled requires a valid
 * treasury PUBLIC key, cluster 'devnet' and a non-mainnet RPC URL; otherwise this throws PaymentsConfigError so the
 * server refuses to start rather than silently running without (or with unsafe) payments.
 */
export function parsePaymentsConfig(env: NodeJS.ProcessEnv): PaymentsConfig {
  const enabled = TRUE_RE.test((env.PAYMENTS_ENABLED ?? '').trim());
  if (!enabled) return { ...DISABLED_PAYMENTS };
  const problems: string[] = [];

  const cluster = (env.SOLANA_CLUSTER ?? 'devnet').trim().toLowerCase();
  if (cluster !== 'devnet') problems.push(`SOLANA_CLUSTER must be "devnet" (got "${cluster}"). Only Solana Devnet is supported.`);

  const rpcUrl = (env.SOLANA_RPC_URL ?? '').trim() || DEFAULT_DEVNET_RPC;
  const urlProblem = checkRpcUrl(rpcUrl);
  if (urlProblem) problems.push(urlProblem);

  for (const name of Object.keys(env)) {
    if (/(PRIVATE|SECRET).*KEY|SEED|MNEMONIC|KEYPAIR/i.test(name) && /SOLANA|TREASURY|WALLET/i.test(name) && env[name]?.trim()) {
      problems.push(`${name} must not be set: this server never holds private keys or seed phrases (public treasury key only).`);
    }
  }

  const treasury = (env.SOLANA_TREASURY_PUBKEY ?? '').trim();
  if (!treasury) {
    problems.push('SOLANA_TREASURY_PUBKEY is required when PAYMENTS_ENABLED=true (the treasury PUBLIC key).');
  } else if (looksLikeSecret(treasury)) {
    problems.push('SOLANA_TREASURY_PUBKEY looks like a SECRET key. Put only the PUBLIC key here and never share the secret.');
  } else {
    const b = decodeBase58(treasury);
    if (!b || b.length !== 32) problems.push('SOLANA_TREASURY_PUBKEY is not a valid Solana public key (base58, 32 bytes).');
  }

  const rawTimeout = Number(env.SOLANA_CONFIRMATION_TIMEOUT_MS);
  const confirmTimeoutMs = Number.isFinite(rawTimeout) && rawTimeout >= 1000 ? Math.min(Math.floor(rawTimeout), 120_000) : DISABLED_PAYMENTS.confirmTimeoutMs;

  if (problems.length) throw new PaymentsConfigError(problems);
  return {
    enabled: true,
    cluster: 'devnet',
    rpcUrl,
    treasury,
    tokenMint: (env.SOLANA_TOKEN_MINT ?? '').trim() || null,
    confirmTimeoutMs,
  };
}
