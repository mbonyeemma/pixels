import { useGame } from '../state';

export default function ToastStack() {
  const toasts = useGame((s) => s.toasts);
  const dismiss = (id: number) => useGame.setState({ toasts: useGame.getState().toasts.filter((t) => t.id !== id) });
  return (
    <div className="toasts" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => {
        const celebrate = t.text.startsWith('Mission complete');
        return (
          <button
            type="button"
            key={t.id}
            className={`toast toast--${t.level}${celebrate ? ' toast--celebrate' : ''}`}
            role={t.level === 'error' ? 'alert' : 'status'}
            onClick={() => dismiss(t.id)}
            title="Dismiss"
          >
            {celebrate ? <span className="confetti" aria-hidden="true" /> : null}
            <span className="toast-text">{t.text}</span>
          </button>
        );
      })}
    </div>
  );
}
