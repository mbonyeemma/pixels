import { useGame } from '../state';
import { IconMoon, IconSun, IconSunrise } from './icons';
import { PHASE_LABEL, dayPhase, formatClock } from './format';

export default function ClockChip() {
  const clock = useGame((s) => s.clock);
  const phase = dayPhase(clock);
  const Icon = phase === 'night' ? IconMoon : phase === 'dawn' || phase === 'dusk' ? IconSunrise : IconSun;
  return (
    <div className={`panel glass clock clock--${phase}`} role="timer" aria-label={`Town time ${formatClock(clock)}, ${PHASE_LABEL[phase]}`}>
      <Icon size={16} />
      <span className="clock-time">{formatClock(clock)}</span>
      <span className="clock-phase">{PHASE_LABEL[phase]}</span>
    </div>
  );
}
