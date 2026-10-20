/** UI state of the wallet feature. No wallet libraries here: this module is part of the main bundle. */
import { create } from 'zustand';

export type PayPhase = 'idle' | 'preparing' | 'wallet' | 'confirming' | 'success' | 'failed';
export interface PayState {
  phase: PayPhase;
  message: string;
  signature?: string;
}
export const IDLE_PAY: PayState = { phase: 'idle', message: '' };
export const isPayBusy = (p: PayState | undefined): boolean => !!p && (p.phase === 'preparing' || p.phase === 'wallet' || p.phase === 'confirming');

export interface WalletInfo {
  name: string;
  icon?: string;
  installed: boolean;
  url?: string;
}
export interface ChallengeInfo {
  nonce: string;
  message: string;
  expiresAt: number;
  purpose: 'link' | 'signin';
}
export type WalletBusy = null | 'connecting' | 'challenge' | 'signing' | 'verifying' | 'unlinking';

export interface WalletState {
  open: boolean;
  /** `signin` = opened from the login screen; `manage` = from the HUD / shop */
  mode: 'manage' | 'signin';
  /** shown at the top of the modal, e.g. "Connect and link a wallet to pay with SOL." */
  hint: string | null;
  wallets: WalletInfo[];
  connectedName: string | null;
  publicKey: string | null;
  busy: WalletBusy;
  error: string | null;
  challenge: ChallengeInfo | null;
  pay: Record<string, PayState>;
  patch: (p: Partial<Omit<WalletState, 'patch' | 'setPay'>>) => void;
  setPay: (itemId: string, s: PayState) => void;
}

export const useWallet = create<WalletState>((set) => ({
  open: false,
  mode: 'manage',
  hint: null,
  wallets: [],
  connectedName: null,
  publicKey: null,
  busy: null,
  error: null,
  challenge: null,
  pay: {},
  patch: (p) => set(p),
  setPay: (itemId, s) => set((st) => ({ pay: { ...st.pay, [itemId]: s } })),
}));
