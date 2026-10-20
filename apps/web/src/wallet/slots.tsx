/**
 * The ONLY wallet code the main bundle contains: tiny placeholders that render the real components from a lazy chunk,
 * and only once GET /api/config said payments are enabled. With payments off (the default) these render null and no
 * wallet code (UI or Solana libraries) is ever downloaded.
 */
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { hasLamportPrice, type ShopItem } from '@pixels/shared';
import { loadPaymentConfig, usePaymentsEnabled } from './config';

const ui = () => import('./ui');
const Toolbar = lazy(() => ui().then((m) => ({ default: m.WalletToolbarButton })));
const SignIn = lazy(() => ui().then((m) => ({ default: m.SignInWithWalletButton })));
const Chip = lazy(() => ui().then((m) => ({ default: m.WalletChip })));
const Pay = lazy(() => ui().then((m) => ({ default: m.PayButton })));
const Host = lazy(() => ui().then((m) => ({ default: m.WalletHost })));
const Resume = lazy(() => ui().then((m) => ({ default: m.ResumePayments })));

function Gate({ children }: { children: ReactNode }) {
  return usePaymentsEnabled() ? <Suspense fallback={null}>{children}</Suspense> : null;
}

export const WalletToolbarSlot = () => (
  <Gate>
    <Toolbar />
  </Gate>
);
export const SignInWithWalletSlot = () => (
  <Gate>
    <SignIn />
  </Gate>
);
export const WalletChipSlot = () => (
  <Gate>
    <Chip />
  </Gate>
);
export const PayButtonSlot = ({ item, disabled }: { item: ShopItem; disabled?: boolean }) =>
  hasLamportPrice(item) ? (
    <Gate>
      <Pay item={item} disabled={disabled} />
    </Gate>
  ) : null;
export const ShopResumeSlot = () => (
  <Gate>
    <Resume />
  </Gate>
);

/** Mount once per screen (login, HUD): fetches /api/config and, if enabled, hosts the wallet modal. */
export function WalletHostSlot() {
  useEffect(() => {
    void loadPaymentConfig();
  }, []);
  return (
    <Gate>
      <Host />
    </Gate>
  );
}
