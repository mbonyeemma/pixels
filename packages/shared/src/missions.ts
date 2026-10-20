import { z } from 'zod';
import { ARRIVE_RADIUS } from './constants';
import { DROPOFF_LOCATION_IDS, LOCATIONS, PICKUP_LOCATION_IDS, TREASURE_SPOT_IDS, locationById } from './world';

export type MissionType = 'visit_location' | 'delivery' | 'treasure_hunt';
export const MISSION_TYPES: MissionType[] = ['visit_location', 'delivery', 'treasure_hunt'];

export interface Reward {
  id: string;
  label: string;
  coins?: number;
  itemId?: string;
}

/** Rewards are fixed server-side configuration. The AI can never choose or alter them. */
export const REWARDS: Record<string, Reward> = {
  reward_visit: { id: 'reward_visit', label: '15 coins (mock in-game reward)', coins: 15 },
  reward_delivery: { id: 'reward_delivery', label: '40 coins (mock in-game reward)', coins: 40 },
  reward_treasure: { id: 'reward_treasure', label: '80 coins + Treasure Hunter Badge (mock in-game reward)', coins: 80, itemId: 'explorer_badge' },
};
export const REWARD_FOR_TYPE: Record<MissionType, string> = {
  visit_location: 'reward_visit',
  delivery: 'reward_delivery',
  treasure_hunt: 'reward_treasure',
};

export const MISSION_LIMITS = {
  offerTtlMs: 5 * 60_000,
  minTotalDistance: 12,
  maxTotalDistance: 400,
  maxActive: 1,
  cooldownMsPerType: 45_000,
  dailyRewardCoinCap: 400,
  minMinutes: 1,
  maxMinutes: 15,
  arriveRadius: ARRIVE_RADIUS,
  /** deadline = max(estimate * factor, floor) */
  deadlineFactor: 3,
  deadlineFloorMs: 5 * 60_000,
} as const;

// eslint-disable-next-line no-control-regex
const stripText = (s: string) => s.replace(/[\u0000-\u001f\u007f<>`]/g, ' ').replace(/\s+/g, ' ').trim();

/** The shape the AI (or rules engine) may propose. Everything is validated before use. */
export const MissionProposalSchema = z.object({
  title: z.string().transform(stripText).pipe(z.string().min(3).max(60)),
  description: z.string().transform(stripText).pipe(z.string().min(5).max(280)),
  type: z.enum(['visit_location', 'delivery', 'treasure_hunt']),
  startLocationId: z.string().max(40),
  objectiveLocationIds: z.array(z.string().max(40)).min(1).max(6),
  estimatedMinutes: z.number().finite().optional(),
  rewardId: z.string().max(40).optional(),
});
export type MissionProposalInput = z.input<typeof MissionProposalSchema>;

export interface MissionProposal {
  title: string;
  description: string;
  type: MissionType;
  startLocationId: string;
  objectiveLocationIds: string[];
  estimatedMinutes: number;
  /** always the fixed reward for the mission type */
  rewardId: string;
}

export type ProposalResult = { ok: true; proposal: MissionProposal } | { ok: false; error: string };

/**
 * Validate an untrusted proposal against trusted world data. The returned reward and
 * (clamped) duration come from configuration, never from the proposer.
 */
export function validateMissionProposal(raw: unknown): ProposalResult {
  const parsed = MissionProposalSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'Mission proposal is malformed: ' + parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ') };
  const p = parsed.data;
  const ids = p.objectiveLocationIds;
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'Objectives must be unique.' };
  const known = (id: string) => !!locationById(id);
  if (!known(p.startLocationId)) return { ok: false, error: `Unknown start location "${p.startLocationId}".` };
  for (const id of ids) if (!known(id)) return { ok: false, error: `Unknown objective location "${id}".` };

  switch (p.type) {
    case 'visit_location': {
      if (ids.length !== 1) return { ok: false, error: 'A visit mission needs exactly one objective.' };
      const loc = locationById(ids[0])!;
      if (loc.hidden || loc.id === 'plaza') return { ok: false, error: 'That location cannot be a visit objective.' };
      break;
    }
    case 'delivery': {
      if (!(PICKUP_LOCATION_IDS as readonly string[]).includes(p.startLocationId)) return { ok: false, error: 'Deliveries must start at a pickup point (bakery or post office).' };
      if (ids.length !== 1) return { ok: false, error: 'A delivery needs exactly one destination.' };
      if (!(DROPOFF_LOCATION_IDS as readonly string[]).includes(ids[0]) || ids[0] === p.startLocationId) return { ok: false, error: 'Invalid delivery destination.' };
      break;
    }
    case 'treasure_hunt': {
      if (ids.length < 2 || ids.length > 4) return { ok: false, error: 'A treasure hunt needs 2-4 spots.' };
      for (const id of ids) if (!TREASURE_SPOT_IDS.includes(id)) return { ok: false, error: `"${id}" is not a treasure spot.` };
      break;
    }
  }
  const minutes = Math.min(MISSION_LIMITS.maxMinutes, Math.max(MISSION_LIMITS.minMinutes, Math.round(p.estimatedMinutes ?? 3)));
  return {
    ok: true,
    proposal: {
      title: p.title,
      description: p.description,
      type: p.type,
      startLocationId: p.startLocationId,
      objectiveLocationIds: ids,
      estimatedMinutes: minutes,
      rewardId: REWARD_FOR_TYPE[p.type],
    },
  };
}

export { LOCATIONS };
