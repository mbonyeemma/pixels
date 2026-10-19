import type { ReactNode } from 'react';

interface Props {
  message?: string;
  children?: ReactNode;
  hint?: string;
  /** cover the whole screen opaquely (initial boot) vs. a translucent veil over the game */
  solid?: boolean;
  /** sit inside the game viewport below the HUD (3D scene loading) instead of covering the whole screen */
  scene?: boolean;
}

export default function LoadingOverlay({ message = 'Loading…', hint, solid = true, scene = false, children }: Props) {
  return (
    <div className={`loading-overlay${solid ? ' loading-overlay--solid' : ''}${scene ? ' loading-overlay--scene' : ''}`} role="status" aria-live="polite">
      <div className="loading-card">
        <div className="spinner" aria-hidden="true" />
        <div className="loading-title">{message}</div>
        {hint ? <div className="loading-hint">{hint}</div> : null}
        {children}
      </div>
    </div>
  );
}
