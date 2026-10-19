import { hashHue } from '../net/sanitize';

/** World clock in [0,1) (0 = midnight, 0.5 = noon) -> "HH:MM". */
export function formatClock(clock: number): string {
  const c = ((clock % 1) + 1) % 1;
  const totalMin = Math.floor(c * 24 * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export type DayPhase = 'night' | 'dawn' | 'morning' | 'afternoon' | 'dusk';

export function dayPhase(clock: number): DayPhase {
  const h = (((clock % 1) + 1) % 1) * 24;
  if (h < 5 || h >= 20) return 'night';
  if (h < 7.5) return 'dawn';
  if (h < 12) return 'morning';
  if (h < 17.5) return 'afternoon';
  return 'dusk';
}

export const PHASE_LABEL: Record<DayPhase, string> = {
  night: 'Night',
  dawn: 'Dawn',
  morning: 'Morning',
  afternoon: 'Afternoon',
  dusk: 'Dusk',
};

/** ms -> "m:ss" (clamped at 0). */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** "name#0427" -> { name, tag } */
export function splitDisplayName(display: string): { name: string; tag: string } {
  const i = display.lastIndexOf('#');
  if (i > 0 && i < display.length - 1) return { name: display.slice(0, i), tag: display.slice(i) };
  return { name: display, tag: '' };
}

/** Player name colour: stable per name, readable on dark glass. */
export const nameColor = (name: string): string => `hsl(${hashHue(name)} 85% 74%)`;

export const mockSuffix = (label: string): string => (/mock/i.test(label) ? label : `${label} (mock)`);

export const formatDistance = (m: number): string => (m >= 100 ? `${Math.round(m / 5) * 5} m` : `${Math.round(m)} m`);

export const KIND_LABEL: Record<string, string> = {
  cosmetic: 'Cosmetic',
  consumable: 'Consumable',
  collectible: 'Collectible',
  badge: 'Badge',
};

export const SLOT_LABEL: Record<string, string> = { hat: 'Hat', face: 'Face', shoes: 'Shoes', jacket: 'Jacket' };

export const MISSION_TYPE_LABEL: Record<string, string> = {
  visit_location: 'Visit',
  delivery: 'Delivery',
  treasure_hunt: 'Treasure hunt',
};

export type DotState = 'done' | 'current' | 'todo';

/**
 * Progress dots for the tracker. Treasure hunts only reveal one spot at a time, so the total comes from the
 * objective label ("Find treasure spot 2 of 3"); other missions list every objective.
 */
export function missionDots(m: { type: string; objectives: { label: string; done: boolean }[]; current: number }): { dots: DotState[]; step: number; total: number } {
  const objs = m.objectives;
  let total = objs.length;
  if (m.type === 'treasure_hunt') {
    const mt = /\bof\s+(\d+)\s*$/i.exec(objs[objs.length - 1]?.label ?? '');
    if (mt) total = Math.max(total, Number(mt[1]));
  }
  const doneCount = objs.filter((o) => o.done).length;
  const cur = Math.min(m.current, Math.max(0, total - 1));
  const dots: DotState[] = Array.from({ length: total }, (_, i) => (i < doneCount || objs[i]?.done ? 'done' : i === cur ? 'current' : 'todo'));
  return { dots, step: Math.min(cur + 1, total), total };
}
