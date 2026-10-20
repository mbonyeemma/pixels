/** HTTP calls to the wallet / payment endpoints. Loaded lazily together with the wallet code. */
import type { PayConfirmResponse, PayIntentView, WalletChallengeView, WalletVerifyResponse } from '@pixels/shared';
import { NETWORK_ERROR_TEXT, httpErrorText, readJson } from '../net/http';
import { apiUrl } from '../net/urls';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; code?: string; pending?: boolean };

async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, token: string | null, body?: unknown, timeoutMs = 45_000): Promise<ApiResult<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl(path), {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = (await readJson(res)) as (T & { error?: string; code?: string; pending?: boolean }) | null;
    if (res.ok && data) return { ok: true, data };
    return { ok: false, status: res.status, error: httpErrorText(data, res.status), code: data?.code, pending: res.status === 202 || data?.pending === true };
  } catch {
    return { ok: false, status: 0, error: NETWORK_ERROR_TEXT };
  } finally {
    clearTimeout(timer);
  }
}

export const requestChallenge = (publicKey: string) => call<WalletChallengeView>('POST', '/api/wallet/challenge', null, { publicKey });

/** With a token the wallet is LINKED to that account; without one the wallet SIGNS IN (if already linked). */
export const verifyWallet = (body: { publicKey: string; signature: string; nonce: string }, token: string | null) =>
  call<WalletVerifyResponse>('POST', '/api/wallet/verify', token, body);

export const unlinkWallet = (token: string) => call<{ account: WalletVerifyResponse['account'] }>('DELETE', '/api/wallet', token);

export const createPayIntent = (itemId: string, token: string) => call<PayIntentView>('POST', '/api/pay/intent', token, { itemId });

export const confirmPayment = (intentId: string, signature: string, token: string) =>
  call<PayConfirmResponse & { message?: string }>('POST', '/api/pay/confirm', token, { intentId, signature }, 60_000);
