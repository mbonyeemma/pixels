/** API / WebSocket URL derivation. Default is same-origin (the Vite dev proxy or the production server). */

export interface LocationLike {
  protocol: string;
  host: string;
}

function envBase(): string | undefined {
  try {
    const v = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_SERVER_URL;
    return v && v.trim() ? v.trim().replace(/\/+$/, '') : undefined;
  } catch {
    return undefined;
  }
}

export function apiUrl(path: string, base: string | undefined = envBase()): string {
  const p = path.startsWith('/') ? path : '/' + path;
  return (base ?? '') + p;
}

export function wsUrl(token: string, base: string | undefined = envBase(), loc: LocationLike = window.location): string {
  const q = `/ws?token=${encodeURIComponent(token)}`;
  if (base) {
    const origin = base.replace(/^http/i, (m) => (m.toLowerCase() === 'https' ? 'wss' : 'ws'));
    return origin + q;
  }
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}${q}`;
}
