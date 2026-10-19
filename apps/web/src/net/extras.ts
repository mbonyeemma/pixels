/**
 * Small UI-only zustand store kept separate from the shared `useGame` contract so we don't change it.
 * Holds state that must survive component unmounts (AI card choices, shop return target, retry timing).
 */
import { create } from 'zustand';
import type { Panel } from '../state';

export type CardState = 'accepted' | 'declined' | 'confirmed' | 'cancelled';

export interface Extras {
  /** per-AI-action-card resolution, keyed `${lineId}:${actionIndex}` */
  cards: Record<string, CardState>;
  /** panel to restore when the shop is closed (set when the AI opens the shop) */
  returnPanel: Panel;
  aiUsage: { remainingToday: number; limitPerDay: number } | null;
  /** Date.now() at which the next automatic reconnect attempt fires, or null */
  retryAt: number | null;
  /** consecutive failed connection attempts */
  attempt: number;
  /** true once the server has told us we were kicked (no automatic reconnect) */
  kicked: boolean;
  setCard: (key: string, state: CardState) => void;
  patch: (p: Partial<Omit<Extras, 'setCard' | 'patch'>>) => void;
}

export const useExtras = create<Extras>((set) => ({
  cards: {},
  returnPanel: 'none',
  aiUsage: null,
  retryAt: null,
  attempt: 0,
  kicked: false,
  setCard: (key, state) => set((s) => ({ cards: { ...s.cards, [key]: state } })),
  patch: (p) => set(p),
}));

export const resetExtras = () =>
  useExtras.setState({ cards: {}, returnPanel: 'none', aiUsage: null, retryAt: null, attempt: 0, kicked: false });
