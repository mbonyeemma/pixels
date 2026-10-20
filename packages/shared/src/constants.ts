export const WORLD_BOUNDS = { minX: -58, maxX: 58, minZ: -58, maxZ: 58 } as const;
export const PLAYER_RADIUS = 0.4;
export const WALK_SPEED = 3.2; // m/s
export const RUN_SPEED = 6.0; // m/s
export const MAX_PLAYERS = 50;
export const INTERACT_RADIUS = 3.5;
export const ARRIVE_RADIUS = 3.2;
export const DAY_LENGTH_SEC = 1200; // one full day/night cycle
export const STARTING_COINS = 100;
export const MOVE_SEND_HZ = 15;
export const SNAPSHOT_HZ = 10;
export const CHAT_MAX_LENGTH = 140;
export const AI_MESSAGE_MAX_LENGTH = 300;
export const USERNAME_REGEX = /^[A-Za-z0-9_]{3,16}$/;
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const ANIMS = ['idle', 'walk', 'run', 'wave', 'dance', 'cheer'] as const;
export type Anim = (typeof ANIMS)[number];
export const EQUIP_SLOTS = ['hat', 'face', 'shoes', 'jacket'] as const;
export type EquipSlot = (typeof EQUIP_SLOTS)[number];

/* ---- optional Solana Devnet payments (test network only: nothing here has real value) ---- */
export const LAMPORTS_PER_SOL = 1_000_000_000;
/** Shown next to every wallet / payment surface (UI and API messages). */
export const DEVNET_LABEL = 'DEVNET TEST — no real value';
/** Genesis hash of Solana Devnet. The server refuses to run payments against any chain with another genesis hash. */
export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
/** How long a pay intent (and a wallet sign-in challenge) is valid. */
export const PAY_INTENT_TTL_MS = 10 * 60_000;
export const WALLET_CHALLENGE_TTL_MS = 5 * 60_000;
