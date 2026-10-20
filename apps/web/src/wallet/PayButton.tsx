import type { ShopItem } from '@pixels/shared';
import { hasLamportPrice } from '@pixels/shared';
import { usePaymentsEnabled } from './config';
import { formatSol, payButtonLabel } from './format';
import { IDLE_PAY, isPayBusy, useWallet } from './store';
import { wallet } from './walletApi';
import './walletLite.css';

const BUSY_LABEL = { preparing: 'Preparing…', wallet: 'Approve in wallet…', confirming: 'Confirming…' } as const;

/** Second buy button in the shop: pay with Devnet SOL. Hidden unless payments are enabled and the item has a lamport price. */
export default function PayButton({ item, disabled }: { item: ShopItem; disabled?: boolean }) {
  const enabled = usePaymentsEnabled();
  const state = useWallet((s) => s.pay[item.id]) ?? IDLE_PAY;
  if (!enabled || !hasLamportPrice(item)) return null;
  const busy = isPayBusy(state);
  const label = busy ? BUSY_LABEL[state.phase as keyof typeof BUSY_LABEL] : payButtonLabel(item.priceLamports);
  const descId = `pay-${item.id}-s`;
  return (
    <div className="shop-sol">
      <div className="shop-sol-row">
        <span className="shop-sol-price" title="Solana Devnet test SOL has no real value">
          ◎ {formatSol(item.priceLamports)} SOL
        </span>
        <button
          type="button"
          className="btn btn--sm btn--sol"
          disabled={disabled || busy}
          aria-describedby={descId}
          title="Pay with Solana Devnet test SOL. Your wallet will ask you to approve. DEVNET TEST — no real value."
          onClick={() => void wallet.pay(item.id)}
        >
          {label}
        </button>
      </div>
      <div id={descId} className={`sol-status${state.phase === 'failed' ? ' sol-status--fail' : state.phase === 'success' ? ' sol-status--ok' : ''}`} role="status" aria-live="polite">
        {state.message}
      </div>
    </div>
  );
}
