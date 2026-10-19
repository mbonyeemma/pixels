import { useEffect } from 'react';
import { useGame } from '../state';
import { closePanel, focusChat, focusGame, isModalPanel, togglePanel } from '../ui/focus';

const FIELD = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const ACTIVATABLE = 'button, a[href], summary, [role="button"], [role="tab"], [role="menuitem"]';

/**
 * The one global key handler for UI shortcuts.
 *  Enter -> focus chat (not while typing / in a modal)    Esc -> blur input, else close the open panel
 *  T -> Town Guide   I -> inventory   H -> help
 * None of them fire while a text input has focus, and WASD / Shift / E / digits are never touched.
 */
export function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const st = useGame.getState();
      if (!st.account) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const inField = !!target?.matches(FIELD);
      if (st.typing && !inField && e.key !== 'Escape') useGame.setState({ typing: false }); // self-heal a stale flag

      if (e.key === 'Escape') {
        if (inField) {
          focusGame();
          e.preventDefault();
        } else if (st.panel !== 'none') {
          closePanel();
          e.preventDefault();
        }
        return;
      }
      if (inField || e.repeat) return;

      switch (e.key) {
        case 'Enter':
          if (isModalPanel(st.panel)) return;
          if (target?.closest(ACTIVATABLE)) return; // let focused buttons/links activate normally
          if (focusChat()) e.preventDefault();
          return;
        case 't':
        case 'T':
          togglePanel('ai');
          e.preventDefault();
          return;
        case 'i':
        case 'I':
          togglePanel('inventory');
          e.preventDefault();
          return;
        case 'h':
        case 'H':
          togglePanel('help');
          e.preventDefault();
          return;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
