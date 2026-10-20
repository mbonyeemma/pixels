import { useEffect, useRef } from 'react';
import { DEVNET_LABEL } from '@pixels/shared';
import { useGame } from '../state';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { IconClose } from '../ui/icons';
import * as ctl from './controller';
import { DEVNET_FAUCET_URL, shortenAddress } from './format';
import { useWallet, type WalletBusy } from './store';
import { wallet } from './walletApi';
import './wallet.css';

const BUSY_TEXT: Record<Exclude<WalletBusy, null>, string> = {
  connecting: 'Waiting for your wallet…',
  challenge: 'Asking Pixels for a message to sign…',
  signing: 'Check your wallet: approve the signature request…',
  verifying: 'Verifying your signature…',
  unlinking: 'Unlinking…',
};

export default function WalletModal() {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref);
  const s = useWallet();
  const account = useGame((g) => g.account);
  const linked = account?.wallet ?? null;
  const connected = !!s.publicKey;
  const busy = s.busy !== null;
  const signinMode = s.mode === 'signin';

  useEffect(() => {
    ctl.init();
    void ctl.tryAutoConnect();
  }, []);

  // sign-in: once a wallet is connected, fetch the message to sign so the player sees exactly what they approve
  useEffect(() => {
    if (signinMode && connected && !s.challenge && !s.busy && !s.error) void ctl.prepareChallenge('signin');
  }, [signinMode, connected, s.challenge, s.busy, s.error]);

  // While the dialog is open, keystrokes must not reach the game (WASD would move the avatar); Escape closes it.
  // Listening on window in the capture phase works even when focus fell back to the page (e.g. a clicked button vanished).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        wallet.close();
      } else if (e.key !== 'Tab') {
        e.stopPropagation(); // Tab stays untouched so the dialog's focus trap keeps working
      }
    };
    const onUp = (e: KeyboardEvent) => e.stopPropagation();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onUp, true);
    };
  }, []);

  const installed = s.wallets.filter((w) => w.installed);
  const notInstalled = s.wallets.filter((w) => !w.installed);
  const challenge = s.challenge;

  return (
    <div className="scrim wallet-scrim" onMouseDown={(e) => e.target === e.currentTarget && wallet.close()}>
      <div ref={ref} className="dialog glass wallet-dialog" role="dialog" aria-modal="true" aria-labelledby="wallet-title" tabIndex={-1}>
        <header className="wallet-head">
          <div>
            <h2 id="wallet-title">{signinMode ? 'Sign in with wallet' : 'Solana wallet'}</h2>
            <span className="tag tag--mock wallet-badge">{DEVNET_LABEL}</span>
          </div>
          <button type="button" className="icon-btn" aria-label="Close wallet" data-autofocus onClick={() => wallet.close()}>
            <IconClose />
          </button>
        </header>

        {s.hint ? (
          <div className="alert alert--info" role="status">
            {s.hint}
          </div>
        ) : null}
        {s.error ? (
          <div className="alert alert--error" role="alert">
            {s.error}
          </div>
        ) : null}
        {s.busy ? (
          <div className="alert alert--info" role="status" aria-live="polite">
            <span className="spinner spinner--sm" aria-hidden="true" /> {BUSY_TEXT[s.busy]}
          </div>
        ) : null}

        {!connected ? (
          <section className="wallet-section" aria-labelledby="wallet-pick-title">
            <h3 id="wallet-pick-title">1. Connect a wallet</h3>
            <p>
              {signinMode
                ? 'Use a wallet you already linked to your Pixels account. Pixels never sees your private key or seed phrase.'
                : 'Pixels never sees your private key or seed phrase. You approve everything in your own wallet.'}
            </p>
            {installed.length > 0 ? (
              <ul className="wallet-list">
                {installed.map((w) => (
                  <li key={w.name}>
                    <button type="button" className="wallet-pick" disabled={busy} onClick={() => void ctl.connect(w.name)}>
                      {w.icon ? <img src={w.icon} alt="" /> : <span className="wallet-pick-ph">◎</span>}
                      {w.name}
                      <span className="wallet-pick-note">Detected</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="alert alert--warn" role="status">
                No Solana wallet was found in this browser. Install one (below), create or import a wallet in it, then reload this page.
              </div>
            )}
            {notInstalled.length > 0 ? (
              <ul className="wallet-list" aria-label="Wallets you can install">
                {notInstalled.map((w) => (
                  <li key={w.name}>
                    <a className="wallet-pick" href={w.url} target="_blank" rel="noreferrer noopener">
                      <span className="wallet-pick-ph">↗</span>
                      Get {w.name}
                      <span className="wallet-pick-note">Not installed</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : (
          <section className="wallet-section" aria-labelledby="wallet-conn-title">
            <h3 id="wallet-conn-title">Connected wallet</h3>
            <div className="wallet-conn">
              <span className="wallet-key" title={s.publicKey ?? undefined}>
                {shortenAddress(s.publicKey)}
              </span>
              <span className="tag tag--mock">DEVNET</span>
              <span className="fineprint">{s.connectedName}</span>
              <button type="button" className="btn btn--xs" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => void ctl.disconnect()}>
                Disconnect
              </button>
            </div>
            <p>Make sure the wallet is set to Solana Devnet (Phantom: Settings, Developer Settings, Testnet Mode).</p>
          </section>
        )}

        {connected && !signinMode ? (
          <section className="wallet-section" aria-labelledby="wallet-link-title">
            <h3 id="wallet-link-title">2. Link it to your Pixels account</h3>
            {!linked ? (
              <>
                <p>
                  Linking proves this wallet is yours. You sign a short text message: it is free, sends no transaction and cannot move funds. Once linked you can also sign in with this wallet.
                </p>
                {!challenge ? (
                  <div className="wallet-actions">
                    <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void ctl.prepareChallenge('link')}>
                      Link wallet
                    </button>
                  </div>
                ) : null}
              </>
            ) : linked === s.publicKey ? (
              <>
                <p>Linked. You can pay with Devnet SOL in the shop and sign in with this wallet.</p>
                <div className="wallet-actions">
                  <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void ctl.unlink()}>
                    Unlink wallet
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="alert alert--warn" role="status">
                  Your account is linked to a different wallet ({shortenAddress(linked)}). Connect that wallet to pay, or unlink it and link this one.
                </div>
                <div className="wallet-actions">
                  <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void ctl.unlink()}>
                    Unlink {shortenAddress(linked)}
                  </button>
                </div>
              </>
            )}
          </section>
        ) : null}

        {challenge ? (
          <section className="wallet-section" aria-labelledby="wallet-sign-title">
            <h3 id="wallet-sign-title">{challenge.purpose === 'signin' ? 'Sign in: approve this message' : 'Link: approve this message'}</h3>
            <p>Your wallet will ask you to sign exactly this text. It is free, sends no transaction and cannot move any funds or tokens.</p>
            <pre className="wallet-msg" tabIndex={0} aria-label="Message to sign">
              {challenge.message}
            </pre>
            <div className="wallet-actions">
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void ctl.signChallenge()}>
                {challenge.purpose === 'signin' ? 'Sign in with wallet' : 'Sign message to link'}
              </button>
              <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => ctl.cancelChallenge()}>
                Cancel
              </button>
            </div>
          </section>
        ) : null}

        {signinMode && connected && !challenge && !busy ? (
          <div className="wallet-actions">
            <button type="button" className="btn btn--primary" onClick={() => void ctl.prepareChallenge('signin')}>
              Get the message to sign
            </button>
          </div>
        ) : null}

        {signinMode ? (
          <p className="wallet-foot">
            Don&apos;t have an account yet? Close this, enter a username and email to create one, then open the Wallet menu in the game to link your wallet.
          </p>
        ) : null}

        <footer className="wallet-foot">
          <strong>{DEVNET_LABEL}.</strong> This is the Solana Devnet test network: SOL here is free and worthless. Need some for testing? Get it from the{' '}
          <a href={DEVNET_FAUCET_URL} target="_blank" rel="noreferrer noopener">
            official Devnet faucet
          </a>
          . Pixels works fully without a wallet.
        </footer>
      </div>
    </div>
  );
}
