/** GET /api/config: is the optional Solana Devnet payments feature on? Tiny and wallet-free (main bundle). */
import { create } from 'zustand';
import type { PaymentConfigView } from '@pixels/shared';
import { readJson } from '../net/http';
import { apiUrl } from '../net/urls';

interface ConfigState {
  loaded: boolean;
  config: PaymentConfigView | null;
}
export const usePaymentConfig = create<ConfigState>(() => ({ loaded: false, config: null }));

export const isPaymentsEnabled = (c: PaymentConfigView | null): c is PaymentConfigView & { treasury: string } =>
  !!c && c.enabled === true && c.cluster === 'devnet' && typeof c.treasury === 'string' && c.treasury.length > 0;

let inflight: Promise<void> | null = null;

/** Fetch the config once. Any failure means "disabled": the game never depends on this. */
export function loadPaymentConfig(force = false): Promise<void> {
  if (!force && usePaymentConfig.getState().loaded) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(apiUrl('/api/config'), { headers: { Accept: 'application/json' } });
      const data = (await readJson(res)) as Partial<PaymentConfigView> | null;
      if (res.ok && data && typeof data.enabled === 'boolean') {
        usePaymentConfig.setState({ loaded: true, config: { enabled: data.enabled, cluster: 'devnet', treasury: data.treasury, tokenMint: data.tokenMint ?? null } });
        return;
      }
    } catch {
      /* treated as disabled */
    }
    usePaymentConfig.setState({ loaded: true, config: { enabled: false, cluster: 'devnet' } });
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** React hook: true only once /api/config said payments are enabled. */
export function usePaymentsEnabled(): boolean {
  return usePaymentConfig((s) => isPaymentsEnabled(s.config));
}
