import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useGame } from './state';
import { gameClient } from './net/client';
import LoginScreen from './ui/LoginScreen';
import LoadingOverlay from './ui/LoadingOverlay';
import ErrorBoundary from './ui/ErrorBoundary';
import Hud from './ui/Hud';
import WebGLNotice from './ui/WebGLNotice';
import { hasWebGL } from './ui/webgl';

// The 3D scene (three / r3f) is a separate chunk: the login screen never pays for it.
const GameCanvas = lazy(() => import('./game/GameCanvas'));

export default function App() {
  const [booting, setBooting] = useState(true);
  const loggedIn = useGame((s) => !!s.account && !!s.token);

  useEffect(() => {
    let alive = true;
    void gameClient.resume().finally(() => {
      if (alive) setBooting(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (booting) return <LoadingOverlay message="Checking your session…" />;
  if (!loggedIn) return <LoginScreen />;
  return <GameScreen />;
}

function GameScreen() {
  const webgl = useMemo(() => hasWebGL(), []);
  const joined = useGame((s) => !!s.selfId);
  const status = useGame((s) => s.status);
  const attemptHint = status === 'reconnecting' ? 'Having trouble reaching the town. Still trying…' : undefined;

  return (
    <div className="game">
      <div className="game-root" data-game-root tabIndex={-1}>
        {webgl ? (
          <ErrorBoundary scope="scene" onLogout={() => gameClient.logout()}>
            <Suspense fallback={<LoadingOverlay scene message="Loading the 3D town…" />}>
              <GameCanvas />
            </Suspense>
          </ErrorBoundary>
        ) : (
          <WebGLNotice />
        )}
      </div>
      <Hud />
      {!joined && status !== 'disconnected' ? (
        <LoadingOverlay solid={false} message="Joining the town…" hint={attemptHint ?? 'Connecting to the server.'}>
          <button type="button" className="btn btn--sm" onClick={() => gameClient.logout()}>
            Cancel and log out
          </button>
        </LoadingOverlay>
      ) : null}
    </div>
  );
}
