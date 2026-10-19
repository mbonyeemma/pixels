import { useState } from 'react';
import { runtime, useGame } from '../state';
import { gameClient } from '../net/client';
import { useTick } from '../hooks/useTick';
import { IconFlag } from './icons';
import { MISSION_TYPE_LABEL, formatCountdown, formatDistance, mockSuffix } from './format';

export default function MissionTracker() {
  const mission = useGame((s) => s.mission);
  const [confirming, setConfirming] = useState(false);
  useTick(500, !!mission);
  if (!mission) return null;

  const total = mission.objectives.length;
  const cur = mission.objectives[Math.min(mission.current, total - 1)];
  const remainingMs = mission.expiresAt - (Date.now() + runtime.serverOffsetMs);
  const dist = cur ? Math.hypot(cur.x - runtime.local.x, cur.z - runtime.local.z) : null;
  const urgent = remainingMs < 60_000;

  return (
    <section className="panel glass mission" aria-label="Current mission">
      <header className="mission-head">
        <IconFlag size={15} />
        <span className="mission-type">{MISSION_TYPE_LABEL[mission.type] ?? 'Mission'}</span>
        <span className={`mission-timer${urgent ? ' is-urgent' : ''}`} title="Time left">
          {remainingMs > 0 ? formatCountdown(remainingMs) : "Time's up"}
        </span>
      </header>
      <h3 className="mission-title">{mission.title}</h3>
      {cur ? (
        <p className="mission-obj">
          <span className="mission-step">
            Step {Math.min(mission.current + 1, total)} of {total}
          </span>
          {cur.label}
          {dist !== null && Number.isFinite(dist) ? <span className="mission-dist"> · {formatDistance(dist)} away</span> : null}
        </p>
      ) : null}
      <ol className="dots" aria-label="Progress">
        {mission.objectives.map((o, i) => (
          <li
            key={o.id}
            className={o.done ? 'is-done' : i === mission.current ? 'is-current' : ''}
            title={o.label}
            aria-label={`${o.label}: ${o.done ? 'done' : i === mission.current ? 'current' : 'to do'}`}
          />
        ))}
      </ol>
      <p className="mission-reward">Reward: {mockSuffix(mission.reward.label)}</p>
      {confirming ? (
        <div className="confirm" role="alertdialog" aria-label="Abandon mission?">
          <span>Abandon this mission?</span>
          <button
            type="button"
            className="btn btn--sm btn--danger"
            onClick={() => {
              setConfirming(false);
              gameClient.abandonMission();
            }}
          >
            Abandon
          </button>
          <button type="button" className="btn btn--sm" autoFocus onClick={() => setConfirming(false)}>
            Keep going
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirming(true)}>
          Abandon
        </button>
      )}
    </section>
  );
}
