/**
 * Main-bundle facade over the lazy wallet controller. Components call these; the first call that needs a wallet
 * triggers the dynamic import, so nothing wallet-related is downloaded unless payments are enabled AND used.
 */
import { useGame } from '../state';
import { pendingPayments } from './pending';
import { useWallet } from './store';

type Controller = typeof import('./controller');
let loading: Promise<Controller> | null = null;

export function loadController(): Promise<Controller> {
  loading ??= import('./controller').catch((err) => {
    loading = null; // allow a retry (e.g. the network came back)
    throw err;
  });
  return loading;
}

const MODULE_ERROR = 'The wallet module could not be loaded. Check your connection and try again.';

export const wallet = {
  open(mode: 'manage' | 'signin' = 'manage', hint: string | null = null): void {
    useWallet.setState({ open: true, mode, hint, error: null });
  },
  close(): void {
    useWallet.setState({ open: false, hint: null, error: null, challenge: null });
  },
  async pay(itemId: string): Promise<void> {
    try {
      await (await loadController()).pay(itemId);
    } catch {
      useWallet.getState().setPay(itemId, { phase: 'failed', message: MODULE_ERROR });
    }
  },
  /** Re-check payments that were sent but not confirmed. Does not load the wallet chunk when nothing is pending. */
  resumePending(): void {
    const account = useGame.getState().account;
    if (!account || pendingPayments(account.id).length === 0) return;
    void loadController().then((c) => c.resumePending()).catch(() => undefined);
  },
};
