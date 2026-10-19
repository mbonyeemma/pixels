/** Tiny fetch helpers shared by the client. */

export async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Human-friendly error text for a failed JSON API call. Prefers the server's own message. */
export function httpErrorText(data: unknown, status: number, fallback = 'Something went wrong. Please try again.'): string {
  const d = data as { error?: unknown; message?: unknown; issues?: { message?: unknown }[] } | null;
  if (d && typeof d.error === 'string' && d.error.trim()) return d.error.trim().slice(0, 200);
  if (d && typeof d.message === 'string' && d.message.trim()) return d.message.trim().slice(0, 200);
  if (d && Array.isArray(d.issues) && typeof d.issues[0]?.message === 'string') return String(d.issues[0].message).slice(0, 200);
  if (status === 429) return 'Too many attempts. Please wait a moment and try again.';
  if (status >= 500) return 'The server ran into a problem. Please try again in a moment.';
  return fallback;
}

export const NETWORK_ERROR_TEXT = "Can't reach the server. Check your connection and try again.";
