import { useEffect } from 'react';
import { wallet } from './walletApi';

/** Mounted with the shop: re-checks a Devnet payment that was sent but never confirmed (closed tab, network drop). */
export default function ResumePayments() {
  useEffect(() => {
    wallet.resumePending();
  }, []);
  return null;
}
