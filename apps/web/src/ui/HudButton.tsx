import type { MouseEvent, ReactNode } from 'react';

interface Props {
  icon: ReactNode;
  label: string;
  /** accessible name suffix + visible key hint */
  shortcut?: string;
  active?: boolean;
  onClick: () => void;
  title?: string;
  className?: string;
}

/** Glass toolbar button. Mouse clicks release focus so game keys keep working; keyboard activation keeps it. */
export default function HudButton({ icon, label, shortcut, active, onClick, title, className }: Props) {
  const handle = (e: MouseEvent<HTMLButtonElement>) => {
    const el = e.currentTarget;
    onClick();
    if (e.detail > 0) el.blur();
  };
  return (
    <button
      type="button"
      className={`hud-btn${active ? ' is-active' : ''}${className ? ` ${className}` : ''}`}
      aria-pressed={active === undefined ? undefined : active}
      aria-label={shortcut ? `${label} (${shortcut})` : label}
      title={title ?? (shortcut ? `${label} (${shortcut})` : label)}
      onClick={handle}
    >
      {icon}
      <span className="hud-btn-label">{label}</span>
      {shortcut ? <kbd>{shortcut}</kbd> : null}
    </button>
  );
}
