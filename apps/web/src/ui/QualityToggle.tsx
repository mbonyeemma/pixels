import { useGame } from '../state';
import { KEYS, safeGet, safeSet } from '../net/storage';
import HudButton from './HudButton';
import { IconGauge } from './icons';

export function loadQuality(): 'low' | 'high' {
  const v = safeGet(KEYS.quality);
  if (v === 'low' || v === 'high') return v;
  try {
    const nav = navigator as Navigator & { deviceMemory?: number };
    if ((nav.hardwareConcurrency && nav.hardwareConcurrency <= 2) || (nav.deviceMemory && nav.deviceMemory <= 2)) return 'low';
  } catch {
    /* ignore */
  }
  return 'high';
}

export default function QualityToggle() {
  const quality = useGame((s) => s.quality);
  const toggle = () => {
    const next = quality === 'high' ? 'low' : 'high';
    useGame.setState({ quality: next });
    safeSet(KEYS.quality, next);
    useGame.getState().toast(next === 'high' ? 'Graphics: high quality' : 'Graphics: low quality (faster on slower computers)');
  };
  return (
    <HudButton
      icon={<IconGauge />}
      label={`Quality: ${quality === 'high' ? 'High' : 'Low'}`}
      title="Toggle graphics quality"
      onClick={toggle}
      className="hud-btn--quality"
    />
  );
}
