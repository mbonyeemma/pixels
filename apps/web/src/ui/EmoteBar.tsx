import { runtime } from '../state';
import type { Anim } from '../types';

const EMOTES: { anim: Anim; label: string; key: string }[] = [
  { anim: 'wave', label: 'Wave', key: '1' },
  { anim: 'dance', label: 'Dance', key: '2' },
  { anim: 'cheer', label: 'Cheer', key: '3' },
];

export default function EmoteBar() {
  return (
    <div className="panel glass emotes" role="group" aria-label="Emotes">
      {EMOTES.map((e) => (
        <button
          key={e.anim}
          type="button"
          className="emote-btn"
          aria-label={`${e.label} (${e.key})`}
          title={`${e.label} (${e.key})`}
          onClick={(ev) => {
            runtime.emoteRequest = e.anim;
            if (ev.detail > 0) ev.currentTarget.blur();
          }}
        >
          <kbd>{e.key}</kbd>
          {e.label}
        </button>
      ))}
    </div>
  );
}
