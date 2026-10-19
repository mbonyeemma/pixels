import { useEffect, useReducer } from 'react';

/** Re-render the calling component every `ms` milliseconds (for countdowns and runtime-derived values). */
export function useTick(ms: number, enabled = true): number {
  const [n, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(bump, ms);
    return () => clearInterval(id);
  }, [ms, enabled]);
  return n;
}
