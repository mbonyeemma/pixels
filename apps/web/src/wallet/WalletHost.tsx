import { Component, lazy, Suspense, useEffect, type ReactNode } from 'react';
import { useGame } from '../state';
import { usePaymentsEnabled } from './config';
import { useWallet } from './store';
import './walletLite.css';

// The modal (and with it every Solana library) is a separate chunk, fetched only when it is first opened.
const WalletModal = lazy(() => import('./WalletModal'));

class ModalBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error('[wallet] modal failed', err);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="scrim wallet-scrim" role="presentation">
        <div className="dialog glass dialog--narrow" role="alertdialog" aria-modal="true" aria-label="Wallet unavailable" tabIndex={-1}>
          <h2>Wallet unavailable</h2>
          <p>The wallet module could not be loaded. The game works fine without it. Check your connection and try again.</p>
          <div className="row">
            <button type="button" className="btn" data-autofocus onClick={() => useWallet.getState().patch({ open: false })}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }
}

/**
 * Mounted once on the login screen and once in the HUD. Fetches /api/config (a few bytes) and renders the wallet
 * modal only when payments are enabled AND the player opened it. With payments off this renders nothing and no
 * wallet code is ever requested.
 */
export default function WalletHost() {
  const enabled = usePaymentsEnabled();
  const open = useWallet((s) => s.open);
  const accountId = useGame((s) => s.account?.id ?? null);

  // a different account (log out / sign in elsewhere) must not inherit pay progress or a half-finished challenge
  useEffect(() => {
    useWallet.setState({ pay: {}, challenge: null, error: null, hint: null });
  }, [accountId]);

  if (!enabled || !open) return null;
  return (
    <ModalBoundary>
      <Suspense
        fallback={
          <div className="scrim wallet-scrim" role="status" aria-live="polite">
            <div className="dialog glass dialog--narrow">
              <p>
                <span className="spinner spinner--sm" aria-hidden="true" /> Loading wallet support…
              </p>
            </div>
          </div>
        }
      >
        <WalletModal />
      </Suspense>
    </ModalBoundary>
  );
}
