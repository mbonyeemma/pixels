import { useGame } from '../state';
import { gameClient } from '../net/client';
import { reconnectNow } from '../net/client';

/** Blocking card when the server has ended the session (kick) or all else failed. */
export function DisconnectedOverlay() {
  const status = useGame((s) => s.status);
  const detail = useGame((s) => s.statusDetail);
  if (status !== 'disconnected') return null;
  return (
    <div className="scrim" role="presentation">
      <div className="dialog glass dialog--narrow" role="alertdialog" aria-modal="true" aria-labelledby="disc-title" aria-describedby="disc-desc">
        <h2 id="disc-title">You were disconnected</h2>
        <p id="disc-desc">{detail || 'The connection to the town was closed.'}</p>
        <div className="row">
          <button type="button" className="btn btn--primary" autoFocus onClick={reconnectNow}>
            Reconnect
          </button>
          <button type="button" className="btn" onClick={() => gameClient.logout()}>
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}

/** Slim banner while the socket is retrying after having been in the town. */
export function ReconnectBanner() {
  const status = useGame((s) => s.status);
  const joined = useGame((s) => !!s.selfId);
  if (status !== 'reconnecting' || !joined) return null;
  return (
    <div className="panel glass banner banner--warn" role="status">
      <span className="spinner spinner--sm" aria-hidden="true" /> Connection lost. Reconnecting…
    </div>
  );
}
