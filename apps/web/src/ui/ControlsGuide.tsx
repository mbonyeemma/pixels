import { useState } from 'react';
import { KEYS, safeGet, safeSet } from '../net/storage';
import { IconChevron, IconKeyboard } from './icons';

const ROWS: { keys: string[]; label: string }[] = [
  { keys: ['W', 'A', 'S', 'D'], label: 'Move' },
  { keys: ['Shift'], label: 'Run' },
  { keys: ['Drag mouse'], label: 'Look around' },
  { keys: ['Scroll'], label: 'Zoom' },
  { keys: ['E'], label: 'Interact' },
  { keys: ['Enter'], label: 'Chat' },
  { keys: ['1', '2', '3'], label: 'Emotes' },
  { keys: ['T'], label: 'AI Town Guide' },
  { keys: ['I'], label: 'Inventory' },
  { keys: ['H'], label: 'Help' },
];

export function ControlList({ compact = false }: { compact?: boolean }) {
  return (
    <ul className={`controls-list${compact ? ' controls-list--compact' : ''}`}>
      {ROWS.map((r) => (
        <li key={r.label}>
          <span className="keys">
            {r.keys.map((k) => (
              <kbd key={k}>{k}</kbd>
            ))}
          </span>
          <span className="key-label">{r.label}</span>
        </li>
      ))}
    </ul>
  );
}

export default function ControlsGuide() {
  const [collapsed, setCollapsed] = useState(() => safeGet(KEYS.controlsCollapsed) === '1');
  const toggle = () => {
    setCollapsed((c) => {
      safeSet(KEYS.controlsCollapsed, c ? '0' : '1');
      return !c;
    });
  };
  return (
    <section className={`panel glass controls${collapsed ? ' is-collapsed' : ''}`} aria-label="Controls">
      <button type="button" className="controls-head" onClick={toggle} aria-expanded={!collapsed}>
        <IconKeyboard size={16} />
        <span>Controls</span>
        <IconChevron size={14} className="chev" />
      </button>
      {collapsed ? null : <ControlList compact />}
    </section>
  );
}
