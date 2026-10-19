/** Guarded localStorage helpers. Storage can be blocked/empty (private mode, previews); never throw. */

export const KEYS = {
  token: 'pixels.token',
  last: 'pixels.last',
  quality: 'pixels.quality',
  controlsCollapsed: 'pixels.controlsCollapsed',
  minimapNorthUp: 'pixels.minimapNorthUp',
  minimapZoom: 'pixels.minimapZoom',
} as const;

export function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export const loadToken = (): string | null => {
  const t = safeGet(KEYS.token);
  return t && t.length > 0 ? t : null;
};
export const saveToken = (token: string): void => safeSet(KEYS.token, token);
export const clearToken = (): void => safeRemove(KEYS.token);

export interface LastLogin {
  username: string;
  email: string;
}

export function loadLastLogin(): LastLogin | null {
  const raw = safeGet(KEYS.last);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LastLogin>;
    if (typeof v.username === 'string' && typeof v.email === 'string') return { username: v.username, email: v.email };
  } catch {
    /* fall through */
  }
  return null;
}

export const saveLastLogin = (v: LastLogin): void => safeSet(KEYS.last, JSON.stringify(v));
