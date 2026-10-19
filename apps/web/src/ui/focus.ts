import { useGame, type Panel } from '../state';
import { useExtras } from '../net/extras';

/** Hand keyboard focus back to the game (the wrapper around the 3D canvas). */
export function focusGame(): void {
  if (typeof document === 'undefined') return;
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body) active.blur?.();
  document.querySelector<HTMLElement>('[data-game-root]')?.focus({ preventScroll: true });
}

export function focusChat(): boolean {
  const el = document.querySelector<HTMLInputElement>('[data-chat-input]');
  if (!el) return false;
  el.focus({ preventScroll: true });
  return true;
}

let aiFocusRequested = false;
/** The AI panel focuses its input on mount only when the player explicitly opened it. */
export const requestAiFocus = (): void => {
  aiFocusRequested = true;
};
export const consumeAiFocus = (): boolean => {
  const v = aiFocusRequested;
  aiFocusRequested = false;
  return v;
};

export const MODAL_PANELS: Panel[] = ['shop', 'help'];
export const isModalPanel = (p: Panel): boolean => MODAL_PANELS.includes(p);

export function closePanel(): void {
  const st = useGame.getState();
  if (st.panel === 'none') return;
  const { returnPanel, patch } = useExtras.getState();
  if (st.panel === 'shop' && returnPanel === 'ai') {
    patch({ returnPanel: 'none' });
    st.setPanel('ai');
    return;
  }
  patch({ returnPanel: 'none' });
  st.setPanel('none');
  focusGame();
}

export function openPanel(p: Panel): void {
  if (p === 'ai') requestAiFocus();
  useExtras.getState().patch({ returnPanel: 'none' });
  useGame.getState().setPanel(p);
}

export function togglePanel(p: Panel): void {
  if (useGame.getState().panel === p) closePanel();
  else openPanel(p);
}
