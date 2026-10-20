import { z } from 'zod';
import { ANIMS, CHAT_MAX_LENGTH, EQUIP_SLOTS, AI_MESSAGE_MAX_LENGTH, EMAIL_REGEX, USERNAME_REGEX, type Anim, type EquipSlot } from './constants';
import type { MissionType } from './missions';
import type { ShopItemView } from './catalog';

/* ------------------------------------------------------------------ HTTP */

export const LoginRequestSchema = z.object({
  username: z.string().regex(USERNAME_REGEX, 'Username must be 3-16 letters, numbers or underscores'),
  email: z.string().max(120).regex(EMAIL_REGEX, 'Enter a valid email address'),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export type Equipped = Partial<Record<EquipSlot, string>>;

/** What the owner can see about their own account (email never goes to other players). */
export interface AccountView {
  id: string;
  username: string;
  /** 4-digit discriminator, e.g. "0427" */
  tag: string;
  /** "username#tag" */
  displayName: string;
  email: string;
  coins: number;
  inventory: Record<string, number>;
  equipped: Equipped;
  wallet?: string | null;
}

export interface LoginResponse {
  token: string;
  account: AccountView;
}

/* ------------------------------------------------- optional Solana Devnet payments */

/** GET /api/config (public). When `enabled` is false there is no wallet UI and the wallet/pay endpoints answer 404. */
export interface PaymentConfigView {
  enabled: boolean;
  /** always 'devnet': the server refuses to run payments against any other cluster */
  cluster: 'devnet';
  /** treasury PUBLIC key that receives payments (only when enabled) */
  treasury?: string;
  /** SPL token mint when token pricing is configured; null/absent = SOL only (token pricing is not implemented yet) */
  tokenMint?: string | null;
}

/** POST /api/wallet/challenge response: the exact text the wallet signs. */
export interface WalletChallengeView {
  nonce: string;
  message: string;
  expiresAt: number;
}

/** POST /api/pay/intent response. The amount comes from the server catalogue only. */
export interface PayIntentView {
  intentId: string;
  itemId: string;
  lamports: number;
  treasury: string;
  /** random one-time public key that must appear (read-only, non-signer) in the payment transaction */
  reference: string;
  /** "pixels:<intentId>" (informational; the reference is what binds the transaction to the intent) */
  memo: string;
  /** payment deadline (ms epoch) */
  expiresAt: number;
  cluster: 'devnet';
}

/** POST /api/wallet/verify response. `signin` carries a fresh token (same shape as LoginResponse). */
export interface WalletVerifyResponse {
  mode: 'link' | 'signin';
  account: AccountView;
  token?: string;
}

/** POST /api/pay/confirm success response. */
export interface PayConfirmResponse {
  ok: true;
  item: { id: string; name: string };
  signature: string;
}

export const AiRequestSchema = z.object({
  message: z.string().trim().min(1).max(AI_MESSAGE_MAX_LENGTH),
});
export type AiRequest = z.infer<typeof AiRequestSchema>;

/** What the AI plans/does. Every action is produced by trusted server code after validation. */
export type AiAction =
  | { type: 'navigate'; locationId: string; label: string; x: number; z: number; distance: number }
  | { type: 'open_shop' }
  | { type: 'show_items'; items: ShopItemView[] }
  | { type: 'mission_offer'; offer: MissionOfferView }
  | { type: 'purchase_proposal'; itemId: string; name: string; price: number; canAfford: boolean }
  | { type: 'players'; players: { name: string; distance: number | null }[] }
  | { type: 'locations'; locations: { id: string; name: string; description: string }[] };

export interface AiResponse {
  reply: string;
  /** the assistant's reading of the request, shown to the player */
  interpretation: string;
  /** human readable steps it took / will take */
  plan: string[];
  actions: AiAction[];
  /** which backend produced the answer */
  provider: string;
  usage: { remainingToday: number; limitPerDay: number };
}

export interface AiErrorResponse {
  error: string;
  code: 'rate_limited' | 'quota_exceeded' | 'timeout' | 'unavailable' | 'bad_request' | 'unauthorized';
  retryAfterSec?: number;
}

/* --------------------------------------------------------------- Realtime */

export interface PlayerView {
  id: string;
  name: string; // displayName
  x: number;
  z: number;
  ry: number;
  anim: Anim;
  equipped: Equipped;
}

export interface SnapshotEntry {
  id: string;
  x: number;
  z: number;
  ry: number;
  anim: Anim;
}

export interface MissionObjectiveView {
  id: string;
  kind: 'goto' | 'pickup' | 'dropoff' | 'collect';
  label: string;
  x: number;
  z: number;
  done: boolean;
}

export interface RewardView {
  label: string;
  coins?: number;
  itemId?: string;
  /** always true in this build: rewards are in-game mock values with no real-world worth */
  mock: true;
}

export interface MissionOfferView {
  offerId: string;
  title: string;
  description: string;
  type: MissionType;
  estimatedMinutes: number;
  objectives: string[];
  reward: RewardView;
  expiresAt: number;
}

export interface MissionStateView {
  id: string;
  type: MissionType;
  title: string;
  description: string;
  reward: RewardView;
  objectives: MissionObjectiveView[];
  /** index of the current objective */
  current: number;
  startedAt: number;
  expiresAt: number;
}

export type MissionEvent = 'accepted' | 'progress' | 'completed' | 'abandoned' | 'expired' | 'rejected';

export type ClientMessage =
  | { t: 'move'; x: number; z: number; ry: number; anim: Anim; seq: number }
  | { t: 'chat'; text: string }
  | { t: 'emote'; anim: Anim }
  | { t: 'interact'; target: string }
  | { t: 'shop_buy'; itemId: string }
  | { t: 'equip'; slot: EquipSlot; itemId: string | null }
  | { t: 'mission_accept'; offerId: string }
  | { t: 'mission_abandon' }
  | { t: 'ping'; c: number };

const finite = z.number().finite().min(-1000).max(1000);
export const ClientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('move'), x: finite, z: finite, ry: z.number().finite().min(-100).max(100), anim: z.enum(ANIMS), seq: z.number().int().min(0).max(2 ** 31) }),
  z.object({ t: z.literal('chat'), text: z.string().min(1).max(CHAT_MAX_LENGTH * 2) }),
  z.object({ t: z.literal('emote'), anim: z.enum(ANIMS) }),
  z.object({ t: z.literal('interact'), target: z.string().min(1).max(40) }),
  z.object({ t: z.literal('shop_buy'), itemId: z.string().min(1).max(40) }),
  z.object({ t: z.literal('equip'), slot: z.enum(EQUIP_SLOTS), itemId: z.string().max(40).nullable() }),
  z.object({ t: z.literal('mission_accept'), offerId: z.string().min(1).max(60) }),
  z.object({ t: z.literal('mission_abandon') }),
  z.object({ t: z.literal('ping'), c: z.number().finite() }),
]);

export type ServerMessage =
  | { t: 'welcome'; you: AccountView; players: PlayerView[]; worldTime: number; serverTime: number; mission: MissionStateView | null; position: { x: number; z: number; ry: number } }
  | { t: 'player_join'; player: PlayerView }
  | { t: 'player_leave'; id: string }
  | { t: 'snap'; time: number; players: SnapshotEntry[] }
  | { t: 'correct'; x: number; z: number; seq: number }
  | { t: 'chat'; id: string; name: string; text: string; time: number }
  | { t: 'appearance'; id: string; equipped: Equipped }
  | { t: 'account'; coins: number; inventory: Record<string, number>; equipped: Equipped }
  | { t: 'shop_result'; ok: boolean; itemId: string; message: string; coins: number }
  | { t: 'mission'; event: MissionEvent; message: string; state: MissionStateView | null; reward?: RewardView }
  | { t: 'toast'; level: 'info' | 'warn' | 'error'; text: string }
  | { t: 'error'; code: string; message: string }
  | { t: 'kicked'; reason: string }
  | { t: 'pong'; c: number; serverTime: number };

/** Time of day in [0,1): 0 = midnight, 0.5 = noon. Derived from the server clock so all players agree. */
export function worldTimeOfDay(serverTimeMs: number, dayLengthSec: number): number {
  return ((serverTimeMs / 1000) % dayLengthSec) / dayLengthSec;
}
