import { useEffect, useMemo, useRef } from 'react';
import { useGame } from '../state';

/**
 * Focus/blur handlers for any text input. While one is focused `useGame.typing` is true so the 3D layer
 * ignores game keys. Resets on unmount so a removed input can never leave the game stuck in "typing".
 */
export function useTypingHandlers(opts: { chat?: boolean } = {}) {
  const focused = useRef(false);
  const chat = !!opts.chat;
  useEffect(() => {
    // (StrictMode's simulated remount keeps the DOM node focused, so re-assert the flag on setup)
    if (focused.current) useGame.setState(chat ? { typing: true, chatOpen: true } : { typing: true });
    return () => {
      if (focused.current) useGame.setState(chat ? { typing: false, chatOpen: false } : { typing: false });
    };
  }, [chat]);
  return useMemo(
    () => ({
      onFocus: () => {
        focused.current = true;
        useGame.setState(chat ? { typing: true, chatOpen: true } : { typing: true });
      },
      onBlur: () => {
        focused.current = false;
        useGame.setState(chat ? { typing: false, chatOpen: false } : { typing: false });
      },
    }),
    [chat],
  );
}
