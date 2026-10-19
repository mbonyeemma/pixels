import { useGame, type ConnectionStatus } from '../state';
import { useExtras } from '../net/extras';
import { reconnectNow } from '../net/client';
import { useTick } from '../hooks/useTick';

const LABEL: Record<ConnectionStatus, string> = {
  idle: 'Offline',
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
};

/** Status chip + retry hint for the player card. */
export default function ConnectionChip() {
  const status = useGame((s) => s.status);
  const detail = useGame((s) => s.statusDetail);
  const retryAt = useExtras((s) => s.retryAt);
  const attempt = useExtras((s) => s.attempt);
  useTick(1000, status === 'reconnecting');

  let text = LABEL[status];
  if (status === 'connected' && detail) text += ` · ${detail}`;

  let hint: string | null = null;
  if (status === 'reconnecting') {
    const secs = retryAt ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) : 0;
    hint = secs > 0 ? `Retrying in ${secs}s (attempt ${attempt + 1})` : 'Retrying now…';
  } else if (status === 'connecting') {
    hint = 'Reaching the town…';
  } else if (status === 'disconnected') {
    hint = detail || 'Lost connection to the server.';
  }

  return (
    <div className="conn" role="status" aria-live="polite">
      <span className={`chip chip--${status}`}>
        <span className="chip-dot" aria-hidden="true" />
        {text}
      </span>
      {hint ? (
        <span className="conn-hint">
          {hint}
          {status === 'reconnecting' || status === 'disconnected' ? (
            <>
              {' '}
              <button type="button" className="link-btn" onClick={reconnectNow}>
                {status === 'disconnected' ? 'Reconnect' : 'Retry now'}
              </button>
            </>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
