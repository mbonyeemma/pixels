/**
 * Client-side state contract shared by the DOM UI (React, zustand) and the 3D scene (react-three-fiber).
 *
 *  - `useGame` (zustand) holds low-frequency UI state: React components subscribe to it.
 *  - `runtime` holds high-frequency mutable data (positions every frame). Never put these in zustand.
 *  - The network layer (net/client.ts) writes both; the 3D scene reads `runtime` and calls `gameClient`.
 */
import { create } from 'zustand';
import type { AccountView, AiAction, Anim, Equipped, MissionOfferView, MissionStateView, Point } from './types';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface ChatLine {
  id: string; // unique line id
  playerId: string;
  name: string;
  text: string;
  time: number;
  system?: boolean;
}

export interface PlayerInfo {
  id: string;
  name: string;
  equipped: Equipped;
}

export interface RemoteRuntime {
  id: string;
  name: string;
  equipped: Equipped;
  /** snapshot buffer for interpolation; times are local performance.now()/1000 at receipt */
  buffer: { t: number; x: number; z: number; ry: number; anim: Anim }[];
  /** current rendered pose (written by the 3D layer) */
  x: number;
  z: number;
  ry: number;
  anim: Anim;
  chatBubble?: { text: string; until: number };
}

export interface AiLine {
  id: string;
  from: 'you' | 'ai';
  text: string;
  interpretation?: string;
  plan?: string[];
  actions?: AiAction[];
  provider?: string;
  error?: boolean;
}

export type Panel = 'none' | 'shop' | 'inventory' | 'ai' | 'help';

export interface GameState {
  // session
  token: string | null;
  account: AccountView | null;
  status: ConnectionStatus;
  statusDetail: string;
  loginError: string | null;
  loading: boolean;
  // world
  players: Record<string, PlayerInfo>; // all players incl. self (name lists, chat names)
  selfId: string | null;
  chat: ChatLine[];
  // gameplay
  mission: MissionStateView | null;
  offers: MissionOfferView[];
  toasts: { id: number; level: 'info' | 'warn' | 'error'; text: string }[];
  nearPrompt: string | null; // e.g. "Press E to open shop"
  // UI focus
  panel: Panel;
  /** true while a text input has focus: the 3D layer must ignore game keys */
  typing: boolean;
  chatOpen: boolean;
  ai: AiLine[];
  aiBusy: boolean;
  quality: 'low' | 'high';
  /** world time of day in [0,1) updated ~1/s by the net layer for UI (3D uses runtime.worldTime) */
  clock: number;
  set: (patch: Partial<GameState>) => void;
  toast: (text: string, level?: 'info' | 'warn' | 'error') => void;
  setPanel: (p: Panel) => void;
}

let toastId = 1;

export const useGame = create<GameState>((set, get) => ({
  token: null,
  account: null,
  status: 'idle',
  statusDetail: '',
  loginError: null,
  loading: false,
  players: {},
  selfId: null,
  chat: [],
  mission: null,
  offers: [],
  toasts: [],
  nearPrompt: null,
  panel: 'none',
  typing: false,
  chatOpen: false,
  ai: [],
  aiBusy: false,
  quality: 'high',
  clock: 0.4,
  set: (patch) => set(patch),
  toast: (text, level = 'info') => {
    const id = toastId++;
    set({ toasts: [...get().toasts.slice(-3), { id, level, text }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), 4500);
  },
  setPanel: (panel) => set({ panel }),
}));

/** High-frequency mutable runtime data. */
export const runtime = {
  /** local player pose, written every frame by the 3D controller */
  local: { x: 0, z: 0, ry: 0, anim: 'idle' as Anim, speed: 0 },
  /** set by the net layer when the server corrects/teleports the local player (3D controller applies then clears) */
  correction: null as null | { x: number; z: number },
  remotes: new Map<string, RemoteRuntime>(),
  /** serverTime - Date.now() in ms */
  serverOffsetMs: 0,
  /** world time of day [0,1) — recomputed by 3D each frame via worldTimeOfDay(Date.now()+serverOffsetMs) */
  /** auto-walk path set by "navigate" actions; the controller follows it until reached or the player takes manual control */
  navPath: null as null | { points: Point[]; label: string; locationId: string },
  localMoveSeq: 0,
  /** UI (emote bar) sets this; the 3D controller consumes it, plays the animation locally and calls gameClient.sendEmote */
  emoteRequest: null as Anim | null,
  /** camera yaw in radians, written by the 3D camera rig (used to rotate the minimap) */
  cameraYaw: 0,
};

/**
 * The network facade. Implemented in net/client.ts. The 3D layer only calls these.
 */
export interface GameClientApi {
  login(username: string, email: string): Promise<void>;
  /** re-use a stored token */
  resume(): Promise<boolean>;
  logout(): void;
  sendMove(x: number, z: number, ry: number, anim: Anim, seq: number): void;
  sendEmote(anim: Anim): void;
  sendChat(text: string): void;
  interact(target: string): void;
  buy(itemId: string): void;
  equip(slot: string, itemId: string | null): void;
  acceptMission(offerId: string): void;
  abandonMission(): void;
  askAi(message: string): Promise<void>;
  /** apply an AI/mission navigate action: computes a path with shared findPath and sets runtime.navPath */
  navigateTo(locationId: string): void;
}
