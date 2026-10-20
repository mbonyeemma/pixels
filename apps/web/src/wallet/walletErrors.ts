/** Wallet discovery helpers and error wording. Used by the lazy wallet controller only (kept out of the main bundle). */

/** Where to get a wallet when none is detected. Detection itself uses the Wallet Standard registry. */
export const RECOMMENDED_WALLETS: readonly { name: string; url: string }[] = [
  { name: 'Phantom', url: 'https://phantom.app/download' },
  { name: 'Solflare', url: 'https://solflare.com/download' },
  { name: 'Backpack', url: 'https://backpack.app/downloads' },
];

export type WalletErrorKind = 'rejected' | 'not_installed' | 'wrong_network' | 'unsupported' | 'unknown';
export interface WalletErrorInfo {
  kind: WalletErrorKind;
  message: string;
}

const REJECT_RE = /reject|denied|declin|cancel|refus|closed|dismiss|not approved/i;
const NETWORK_RE = /network|cluster|chain|devnet|genesis|blockhash/i;

/**
 * Turn whatever a wallet adapter throws into a short, friendly message. Adapter errors carry a class name
 * (WalletConnectionError, WalletSignMessageError, WalletSendTransactionError...) and often a wrapped `error`.
 */
export function describeWalletError(err: unknown): WalletErrorInfo {
  const e = err as { name?: unknown; message?: unknown; code?: unknown; error?: { message?: unknown; code?: unknown } } | null;
  const name = typeof e?.name === 'string' ? e.name : '';
  const inner = typeof e?.error?.message === 'string' ? e.error.message : '';
  const text = `${typeof e?.message === 'string' ? e.message : ''} ${inner}`.trim();
  const code = e?.code ?? e?.error?.code;

  if (name === 'WalletNotReadyError' || name === 'WalletNotInstalled') {
    return { kind: 'not_installed', message: 'That wallet is not installed or not ready in this browser. Install it, reload this page and try again.' };
  }
  if (code === 4001 || code === 'ACTION_REJECTED' || REJECT_RE.test(text)) {
    return { kind: 'rejected', message: 'You declined the request in your wallet. Nothing was sent and nothing was charged.' };
  }
  if (name === 'WalletAccountError' || name === 'WalletConfigError' || /does not support|not support|unsupported/i.test(text)) {
    return { kind: 'unsupported', message: 'This wallet cannot do what Pixels needs (sign a message and send a transaction on Solana). Try Phantom, Solflare or Backpack.' };
  }
  if (name === 'WalletSendTransactionError' && (!text || NETWORK_RE.test(text))) {
    return {
      kind: 'wrong_network',
      message: 'Your wallet could not send this on Solana Devnet. Switch your wallet to Devnet (Phantom: Settings > Developer Settings > Testnet Mode, then choose Solana Devnet) and try again.',
    };
  }
  if (NETWORK_RE.test(text)) {
    return { kind: 'wrong_network', message: `Network problem: make sure your wallet is on Solana Devnet. (${text.slice(0, 120)})` };
  }
  return { kind: 'unknown', message: text ? `The wallet reported a problem: ${text.slice(0, 160)}` : 'The wallet reported an unknown problem. Please try again.' };
}
