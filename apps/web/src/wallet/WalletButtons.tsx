import { useGame } from '../state';
import HudButton from '../ui/HudButton';
import { usePaymentsEnabled } from './config';
import { shortenAddress } from './format';
import { useWallet } from './store';
import { wallet } from './walletApi';
import WalletIcon from './WalletIcon';
import './walletLite.css';

/** HUD toolbar button. Renders nothing unless /api/config says payments are enabled. */
export function WalletToolbarButton() {
  const enabled = usePaymentsEnabled();
  const open = useWallet((s) => s.open);
  if (!enabled) return null;
  return (
    <HudButton
      icon={<WalletIcon />}
      label="Wallet"
      active={open}
      title="Solana wallet (Devnet test, no real value)"
      onClick={() => (open ? wallet.close() : wallet.open('manage'))}
    />
  );
}

/** Login screen: for accounts that already linked a wallet. */
export function SignInWithWalletButton() {
  const enabled = usePaymentsEnabled();
  const loading = useGame((s) => s.loading);
  if (!enabled) return null;
  return (
    <div className="wallet-signin">
      <div className="wallet-signin-or" aria-hidden="true">
        <span>or</span>
      </div>
      <button type="button" className="btn btn--block" disabled={loading} onClick={() => wallet.open('signin')}>
        <WalletIcon /> Sign in with wallet
      </button>
      <p className="login-note login-note--dim">
        <span className="tag tag--mock">DEVNET TEST — no real value</span> Only for accounts that already linked a wallet. New here? Create an account above first, then link a wallet in the game.
      </p>
    </div>
  );
}

/** Small chip under the player's name: the linked wallet, with a DEVNET badge. */
export function WalletChip() {
  const enabled = usePaymentsEnabled();
  const linked = useGame((s) => s.account?.wallet ?? null);
  if (!enabled || !linked) return null;
  return (
    <button type="button" className="wallet-chip" title={`Linked wallet ${linked} (Devnet test, no real value). Click to manage.`} onClick={() => wallet.open('manage')}>
      <WalletIcon size={13} />
      <span>{shortenAddress(linked)}</span>
      <span className="wallet-chip-net">DEVNET</span>
    </button>
  );
}
