interface Props {
  message?: string;
  hint?: string;
  /** cover the whole screen opaquely (initial boot) vs. a translucent veil over the game */
  solid?: boolean;
}

export default function LoadingOverlay({ message = 'Loading…', hint, solid = true }: Props) {
  return (
    <div className={`loading-overlay${solid ? ' loading-overlay--solid' : ''}`} role="status" aria-live="polite">
      <div className="loading-card">
        <div className="spinner" aria-hidden="true" />
        <div className="loading-title">{message}</div>
        {hint ? <div className="loading-hint">{hint}</div> : null}
      </div>
    </div>
  );
}
