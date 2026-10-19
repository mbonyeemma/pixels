import { useState } from 'react';
import { runtime, useGame } from '../state';
import { gameClient } from '../net/client';
import { useTick } from '../hooks/useTick';
import { IconFlag } from './icons';
import { MISSION_TYPE_LABEL, formatCountdown, formatDistance, missionDots, mockSuffix } from './format';

export default function MissionTracker() {
  const mission = useGame((s) => s.mission);
  const [confirming, setConfirming] = useState(false);
  useTick(500, !!mission);
  if (!mission) return null;

  const progress = missionDots(mission);
  const cur = mission.objectives[Math.min(mission.current, mission.objectives.length - 1)];
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
          {progress.total > 1 ? (
            <span className="mission-step">
              Step {progress.step} of {progress.total}
            </span>
          ) : null}
          {cur.label}
          {dist !== null && Number.isFinite(dist) ? <span className="mission-dist"> · {formatDistance(dist)} away</span> : null}
        </p>
      ) : null}
      <ol className="dots" aria-label={`Progress: step ${progress.step} of ${progress.total}`}>
        {progress.dots.map((d, i) => (
          <li key={i} className={d === 'done' ? 'is-done' : d === 'current' ? 'is-current' : ''} aria-label={`Step ${i + 1}: ${d === 'todo' ? 'to do' : d}`} />
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
