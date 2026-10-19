import {
  INTERACT_RADIUS,
  MISSION_LIMITS,
  REWARDS,
  REWARD_FOR_TYPE,
  WALK_SPEED,
  itemById,
  locationById,
  validateMissionProposal,
  walkDistance,
  type MissionObjectiveView,
  type MissionOfferView,
  type MissionProposal,
  type MissionStateView,
  type MissionType,
  type Point,
  type RewardView,
  type ServerMessage,
  type MissionEvent,
} from '@pixels/shared';
import type { AccountRecord, ActiveMissionObjective, ActiveMissionRecord, Database } from './db';
import type { Logger } from './log';
import { clamp, dayKey, dist2d, randomHex, round, type Clock } from './util';

/** Extra metres allowed on top of INTERACT_RADIUS: the server position lags the client by about one move message. */
export const INTERACT_SLACK = 0.5;

export type OfferResult = { ok: true; offer: MissionOfferView } | { ok: false; error: string };

export interface MissionDeps {
  db: Database;
  clock: Clock;
  log: Logger;
  /** server-side position of the player (live position, else last known, else spawn) */
  getPosition(accountId: string): Point;
  /** deliver a realtime message to the player if they are online */
  notify(accountId: string, msg: ServerMessage): void;
}

interface StoredOffer {
  offerId: string;
  accountId: string;
  proposal: MissionProposal;
  distance: number;
  expiresAt: number;
}

const TYPE_NAMES: Record<MissionType, string> = {
  visit_location: 'visit',
  delivery: 'delivery',
  treasure_hunt: 'treasure hunt',
};

export function rewardViewFor(type: MissionType): RewardView {
  const r = REWARDS[REWARD_FOR_TYPE[type]];
  return { label: r.label, coins: r.coins, itemId: r.itemId, mock: true };
}

/** Objective list for a validated proposal. Objective ids are location ids (the `interact` target). */
function buildObjectives(p: MissionProposal): ActiveMissionObjective[] {
  const name = (id: string) => locationById(id)?.name ?? id;
  switch (p.type) {
    case 'visit_location':
      return [{ id: p.objectiveLocationIds[0], kind: 'goto', label: `Visit ${name(p.objectiveLocationIds[0])}`, done: false }];
    case 'delivery':
      return [
        { id: p.startLocationId, kind: 'pickup', label: `Pick up the parcel at ${name(p.startLocationId)}`, done: false },
        { id: p.objectiveLocationIds[0], kind: 'dropoff', label: `Deliver it to ${name(p.objectiveLocationIds[0])}`, done: false },
      ];
    case 'treasure_hunt':
      return p.objectiveLocationIds.map((id, i, all) => ({
        id,
        kind: 'collect' as const,
        label: `Find treasure spot ${i + 1} of ${all.length}`,
        done: false,
      }));
  }
}

/** Locations the player has to walk through (in order) for distance purposes. */
function walkStops(p: MissionProposal): string[] {
  // For visits and hunts the start location is only informational: the player starts wherever they are standing.
  return p.type === 'delivery' ? [p.startLocationId, ...p.objectiveLocationIds] : [...p.objectiveLocationIds];
}

export function toStateView(m: ActiveMissionRecord): MissionStateView {
  // Treasure spots are revealed one at a time: later spots are not sent to the client.
  const visible = m.type === 'treasure_hunt' ? m.objectives.slice(0, m.current + 1) : m.objectives;
  const objectives: MissionObjectiveView[] = visible.map((o) => {
    const loc = locationById(o.id);
    return { id: o.id, kind: o.kind, label: o.label, x: loc?.x ?? 0, z: loc?.z ?? 0, done: o.done };
  });
  return {
    id: m.id,
    type: m.type,
    title: m.title,
    description: m.description,
    reward: rewardViewFor(m.type),
    objectives,
    current: m.current,
    startedAt: m.startedAt,
    expiresAt: m.expiresAt,
  };
}

export class MissionEngine {
  /** at most one pending offer per player */
  private offers = new Map<string, StoredOffer>();

  constructor(private readonly deps: MissionDeps) {}

  /* ------------------------------------------------------------- helpers */

  private account(id: string): AccountRecord | undefined {
    return this.deps.db.getAccount(id);
  }

  private emit(accountId: string, event: MissionEvent, message: string, state: MissionStateView | null, reward?: RewardView): void {
    const msg: ServerMessage = reward ? { t: 'mission', event, message, state, reward } : { t: 'mission', event, message, state };
    this.deps.notify(accountId, msg);
  }

  private reject(accountId: string, message: string): void {
    const a = this.account(accountId);
    this.emit(accountId, 'rejected', message, a?.activeMission ? toStateView(a.activeMission) : null);
  }

  private sendAccount(a: AccountRecord): void {
    this.deps.notify(a.id, { t: 'account', coins: a.coins, inventory: { ...a.inventory }, equipped: { ...a.equipped } });
  }

  /** Active mission of an account; clears and reports it first if it has run out of time. */
  private active(a: AccountRecord): ActiveMissionRecord | null {
    const m = a.activeMission;
    if (!m) return null;
    if (this.deps.clock() > m.expiresAt) {
      this.expire(a, m);
      return null;
    }
    return m;
  }

  private expire(a: AccountRecord, m: ActiveMissionRecord): void {
    a.activeMission = null;
    this.deps.db.save();
    this.deps.log.info('mission expired', { account: a.id, type: m.type });
    this.emit(a.id, 'expired', `Time ran out for "${m.title}".`, null);
  }

  private dailyEarned(a: AccountRecord, now: number): number {
    return a.dailyRewards.day === dayKey(now) ? a.dailyRewards.coins : 0;
  }

  private dailyRemaining(a: AccountRecord, now: number): number {
    return Math.max(0, MISSION_LIMITS.dailyRewardCoinCap - this.dailyEarned(a, now));
  }

  private cooldownRemainingMs(a: AccountRecord, type: MissionType, now: number): number {
    const last = a.lastCompletedAt[type];
    if (last === undefined) return 0;
    return Math.max(0, last + MISSION_LIMITS.cooldownMsPerType - now);
  }

  /* ------------------------------------------------------------ queries */

  /** Mission state for the welcome message (pure: an expired mission is reported as none; `checkExpiry` clears it). */
  stateView(accountId: string): MissionStateView | null {
    const a = this.account(accountId);
    const m = a?.activeMission;
    if (!m || this.deps.clock() > m.expiresAt) return null;
    return toStateView(m);
  }

  /** Clear + announce an expired mission (used right after a reconnect and by the periodic sweep). */
  checkExpiry(accountId: string): void {
    const a = this.account(accountId);
    if (a) this.active(a);
  }

  pendingOffer(accountId: string): MissionOfferView | null {
    const o = this.offers.get(accountId);
    if (!o || this.deps.clock() > o.expiresAt) return null;
    return this.offerView(o);
  }

  private offerView(o: StoredOffer): MissionOfferView {
    const p = o.proposal;
    return {
      offerId: o.offerId,
      title: p.title,
      description: p.description,
      type: p.type,
      estimatedMinutes: p.estimatedMinutes,
      objectives: buildObjectives(p).map((x) => x.label),
      reward: rewardViewFor(p.type),
      expiresAt: o.expiresAt,
    };
  }

  /* -------------------------------------------------------------- offers */

  /**
   * Validate an untrusted proposal (from the AI or rules engine) and store it as the player's single pending offer.
   * Reward, duration and eligibility are decided here, never by the proposer.
   */
  createOffer(accountId: string, raw: unknown): OfferResult {
    const a = this.account(accountId);
    if (!a) return { ok: false, error: 'Unknown player.' };
    const validated = validateMissionProposal(raw);
    if (!validated.ok) return { ok: false, error: validated.error };
    const p = validated.proposal;
    const now = this.deps.clock();

    if (this.active(a)) return { ok: false, error: 'You already have an active mission. Finish or abandon it before taking another.' };
    const cd = this.cooldownRemainingMs(a, p.type, now);
    if (cd > 0) {
      return { ok: false, error: `You just finished a ${TYPE_NAMES[p.type]} mission. Try a different kind, or wait ${Math.ceil(cd / 1000)} seconds.` };
    }
    if (this.dailyRemaining(a, now) <= 0) {
      return { ok: false, error: 'You have reached the daily mission reward limit. Come back tomorrow.' };
    }

    // walking distance from where the player actually is, through every stop
    let from: Point = this.deps.getPosition(accountId);
    let total = 0;
    for (const id of walkStops(p)) {
      const loc = locationById(id)!;
      const d = walkDistance(from, loc);
      if (!Number.isFinite(d)) return { ok: false, error: 'One of the places in that mission cannot be reached on foot.' };
      total += d;
      from = loc;
    }
    if (total < MISSION_LIMITS.minTotalDistance) {
      return { ok: false, error: `That is too close (${Math.round(total)} m). Missions must involve at least ${MISSION_LIMITS.minTotalDistance} m of walking.` };
    }
    if (total > MISSION_LIMITS.maxTotalDistance) {
      return { ok: false, error: `That is too far (${Math.round(total)} m). Missions can cover at most ${MISSION_LIMITS.maxTotalDistance} m of walking.` };
    }

    const estimatedMinutes = clamp(
      Math.ceil(total / (WALK_SPEED * 0.8) / 60),
      MISSION_LIMITS.minMinutes,
      MISSION_LIMITS.maxMinutes,
    );
    const offer: StoredOffer = {
      offerId: 'offer_' + randomHex(8),
      accountId,
      proposal: { ...p, estimatedMinutes },
      distance: round(total, 1),
      expiresAt: now + MISSION_LIMITS.offerTtlMs,
    };
    this.offers.set(accountId, offer); // replaces any older pending offer
    this.deps.log.info('mission offer', { account: accountId, type: p.type, distance: offer.distance });
    return { ok: true, offer: this.offerView(offer) };
  }

  /* -------------------------------------------------------------- accept */

  accept(accountId: string, offerId: string): void {
    const a = this.account(accountId);
    if (!a) return;
    const now = this.deps.clock();
    const offer = this.offers.get(accountId);
    if (offer && now > offer.expiresAt) this.offers.delete(accountId);
    if (!offer || offer.offerId !== offerId || now > offer.expiresAt) {
      return this.reject(accountId, 'That mission offer is no longer available.');
    }
    if (this.active(a)) return this.reject(accountId, 'You already have an active mission.');
    const p = offer.proposal;
    const cd = this.cooldownRemainingMs(a, p.type, now);
    if (cd > 0) return this.reject(accountId, `Mission cooldown: wait ${Math.ceil(cd / 1000)} seconds.`);
    if (this.dailyRemaining(a, now) <= 0) return this.reject(accountId, 'You have reached the daily mission reward limit.');

    const deadlineMs = Math.max(p.estimatedMinutes * 60_000 * MISSION_LIMITS.deadlineFactor, MISSION_LIMITS.deadlineFloorMs);
    const mission: ActiveMissionRecord = {
      id: 'm_' + randomHex(9),
      type: p.type,
      title: p.title,
      description: p.description,
      objectives: buildObjectives(p),
      current: 0,
      startedAt: now,
      expiresAt: now + deadlineMs,
    };
    this.offers.delete(accountId);
    a.activeMission = mission;
    this.deps.db.save();
    this.deps.log.info('mission accepted', { account: accountId, type: p.type });
    this.emit(accountId, 'accepted', `Mission started: ${p.title}`, toStateView(mission));
    // the player may already be standing at the destination
    const pos = this.deps.getPosition(accountId);
    this.onMove(accountId, pos.x, pos.z);
  }

  abandon(accountId: string): void {
    const a = this.account(accountId);
    if (!a) return;
    const m = this.active(a);
    if (!m) return this.reject(accountId, 'You have no active mission.');
    a.activeMission = null;
    this.deps.db.save();
    this.deps.log.info('mission abandoned', { account: accountId, type: m.type });
    this.emit(accountId, 'abandoned', `Mission abandoned: ${m.title}`, null);
  }

  /* ------------------------------------------------------------ progress */

  /** Called with the server's accepted position after every valid move. Completes `goto` objectives. */
  onMove(accountId: string, x: number, z: number): void {
    const a = this.account(accountId);
    const m = a?.activeMission;
    if (!a || !m) return;
    const obj = m.objectives[m.current];
    if (!obj || obj.kind !== 'goto') return;
    const loc = locationById(obj.id);
    if (!loc) return;
    if (this.deps.clock() > m.expiresAt) return void this.expire(a, m);
    if (dist2d(x, z, loc.x, loc.z) <= MISSION_LIMITS.arriveRadius) this.advance(a, m);
  }

  /**
   * Handle an `interact` for pickup / dropoff / collect objectives. The target must be exactly the current objective,
   * and the player's server-side position must be within INTERACT_RADIUS of it. Everything else is rejected.
   */
  interact(accountId: string, target: string): void {
    const a = this.account(accountId);
    if (!a) return;
    const hadMission = a.activeMission !== null;
    const m = this.active(a); // announces 'expired' itself when the deadline has passed
    if (!m) {
      if (!hadMission) this.reject(accountId, 'You have no active mission.');
      return;
    }
    const obj = m.objectives[m.current];
    if (!obj) return this.reject(accountId, 'There is nothing left to do.');
    const loc = locationById(target);
    if (!loc) return this.reject(accountId, 'There is nothing to interact with there.');
    if (obj.id !== target) return this.reject(accountId, `That is not your next objective. Next: ${obj.label}.`);
    if (obj.kind === 'goto') return this.reject(accountId, 'Just walk there: you will arrive automatically.');
    const pos = this.deps.getPosition(accountId);
    if (dist2d(pos.x, pos.z, loc.x, loc.z) > INTERACT_RADIUS + INTERACT_SLACK) {
      return this.reject(accountId, 'You are too far away. Get closer and try again.');
    }
    this.advance(a, m);
  }

  /** Mark the current objective done and move on, or finish the mission. */
  private advance(a: AccountRecord, m: ActiveMissionRecord): void {
    const obj = m.objectives[m.current];
    obj.done = true;
    m.current += 1;
    if (m.current >= m.objectives.length) return this.complete(a, m);
    this.deps.db.save();
    const next = m.objectives[m.current];
    let message: string;
    switch (obj.kind) {
      case 'pickup':
        message = `Parcel collected. Next: ${next.label}.`;
        break;
      case 'collect':
        message = `Treasure spot found (${m.current}/${m.objectives.length}). Next: ${next.label}.`;
        break;
      default:
        message = `Done: ${obj.label}. Next: ${next.label}.`;
    }
    this.emit(a.id, 'progress', message, toStateView(m));
  }

  /* ----------------------------------------------------------- completion */

  private complete(a: AccountRecord, m: ActiveMissionRecord): void {
    const now = this.deps.clock();
    if (a.missionClaims[m.id] !== undefined) {
      // already paid out (e.g. replay after a crash between payout and clearing): never pay twice
      a.activeMission = null;
      this.deps.db.save();
      return this.reject(a.id, 'That mission was already completed.');
    }
    const reward = this.grantReward(a, m.type, now);
    a.missionClaims[m.id] = now;
    this.deps.db.pruneClaims(a);
    a.lastCompletedAt[m.type] = now;
    a.activeMission = null;
    this.deps.db.save();
    this.deps.log.info('mission completed', { account: a.id, type: m.type, coins: reward.coins ?? 0 });
    this.sendAccount(a);
    this.emit(a.id, 'completed', `Mission complete: ${m.title}! Reward: ${reward.label}`, null, reward);
  }

  /** Pay the fixed reward for this mission type (from REWARDS only), honouring the daily coin cap and single-copy items. */
  private grantReward(a: AccountRecord, type: MissionType, now: number): RewardView {
    const reward = REWARDS[REWARD_FOR_TYPE[type]];
    const today = dayKey(now);
    if (a.dailyRewards.day !== today) a.dailyRewards = { day: today, coins: 0 };
    const remaining = Math.max(0, MISSION_LIMITS.dailyRewardCoinCap - a.dailyRewards.coins);
    const wanted = reward.coins ?? 0;
    const coins = Math.min(wanted, remaining);
    a.coins += coins;
    a.dailyRewards.coins += coins;

    let granted: string | undefined;
    let itemName: string | undefined;
    if (reward.itemId) {
      const item = itemById(reward.itemId);
      if (item && (item.kind === 'consumable' || !((a.inventory[item.id] ?? 0) > 0))) {
        a.inventory[item.id] = (a.inventory[item.id] ?? 0) + 1;
        granted = item.id;
        itemName = item.name;
      }
    }
    const clipped = coins < wanted;
    const wholeReward = !clipped && (!reward.itemId || granted !== undefined);
    if (wholeReward) return { label: reward.label, coins: wanted || undefined, itemId: granted, mock: true };
    const parts: string[] = [];
    if (coins > 0) parts.push(`${coins} coins`);
    if (itemName) parts.push(itemName);
    const note = clipped ? 'mock in-game reward, daily limit reached' : 'mock in-game reward';
    return { label: `${parts.join(' + ') || 'No reward'} (${note})`, coins: coins || undefined, itemId: granted, mock: true };
  }

  /* -------------------------------------------------------------- upkeep */

  /** Expire timed-out missions of the given online accounts and drop stale offers. */
  sweep(onlineAccountIds: Iterable<string>): void {
    const now = this.deps.clock();
    for (const id of onlineAccountIds) this.checkExpiry(id);
    for (const [id, o] of this.offers) if (now > o.expiresAt) this.offers.delete(id);
  }
}
