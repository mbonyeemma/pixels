import type { AiAction } from '@pixels/shared';
import { cleanReply, norm } from './text';

/**
 * Facts the assistant collected from trusted tool results during ONE turn. Any money statement in the
 * final reply has to be explainable by these facts, otherwise the reply is replaced by a templated one.
 */
export interface TurnFacts {
  /** items whose catalogue price was returned by a tool this turn */
  items: Map<string, { name: string; price: number }>;
  /** the player's coin balance, if get_player_context ran */
  balance: number | null;
  /** coin amounts that appear in mission offers / quest descriptions returned this turn */
  rewardCoins: Set<number>;
}

export const newFacts = (): TurnFacts => ({ items: new Map(), balance: null, rewardCoins: new Set() });

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)`;
const COIN_UNITS = String.raw`(?:coins?|credits?|tokens?|gold|gems?|bucks|dollars?|usd|eur|euros?|eth|sol|btc|usdc|usdt)`;
const COIN_AMOUNT_RE = new RegExp(String.raw`(?<![\w.,])${NUM}\s*(k\b)?\s*(?:mock\s+|in-?game\s+|pixel\s+|test\s+|virtual\s+)?${COIN_UNITS}\b`, 'gi');
const COST_AMOUNT_RE = new RegExp(String.raw`\b(?:costs?|prices?|priced(?:\s+at)?|worth|fee)\s*(?:is|of|at|about|around|only|just|=|:)?\s*${NUM}\b`, 'gi');
const CURRENCY_SYMBOL_RE = /[$€£¥]\s*\d|\d\s*[$€£¥]/;

function toNumber(raw: string, k: string | undefined): number {
  const n = Number(raw.replace(/,/g, ''));
  return k ? n * 1000 : n;
}

/** Every coin-like amount mentioned in `text` (e.g. "40 coins", "costs 40", "1k coins"). */
export function extractCoinAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(COIN_AMOUNT_RE)) out.push(toNumber(m[1], m[2]));
  for (const m of text.matchAll(COST_AMOUNT_RE)) out.push(toNumber(m[1], undefined));
  return out;
}

const shortName = (name: string) => norm(name.replace(/\([^)]*\)/g, ' '));

function allowedFor(sentence: string, facts: TurnFacts): Set<number> {
  const n = norm(sentence);
  const mentioned = [...facts.items.entries()].filter(([id, it]) => {
    const sn = shortName(it.name);
    return (sn && n.includes(sn)) || n.includes(id.replace(/_/g, ' '));
  });
  const allowed = new Set<number>(facts.rewardCoins);
  const pool = mentioned.length ? mentioned.map(([, v]) => v.price) : [...facts.items.values()].map((v) => v.price);
  for (const p of pool) allowed.add(p);
  if (facts.balance !== null) {
    allowed.add(facts.balance);
    // "you need N more coins" is derived from tool data, so it is allowed too
    for (const p of pool) if (p > facts.balance) allowed.add(p - facts.balance);
  }
  return allowed;
}

/**
 * True when every coin/price amount in `text` matches a catalogue price, reward or balance returned by a
 * tool this turn (sentence by sentence: a sentence naming an item may only quote that item's price).
 */
export function amountsMatchFacts(text: string, facts: TurnFacts): boolean {
  if (CURRENCY_SYMBOL_RE.test(text)) return false;
  for (const sentence of text.split(/(?<=[.!?\n])\s+|\n/)) {
    const amounts = extractCoinAmounts(sentence);
    if (!amounts.length) continue;
    const allowed = allowedFor(sentence, facts);
    if (amounts.some((a) => !allowed.has(a))) return false;
  }
  return true;
}

/** Statements that claim a state change the assistant can never perform. */
const FALSE_CLAIM_RES: RegExp[] = [
  /\bi\s*(?:'ve|’ve|have|had)?\s*(?:just\s+|now\s+|already\s+)?(?:bought|purchased|signed|paid|minted|transferred|credited|unlocked|confirmed|approved)\b/i,
  /\bi\s*(?:'ve|’ve|have)?\s*(?:just\s+|now\s+)?(?:gave|given|granted|sent|added|deposited)\s+(?:you\s+)?(?:\d|some|extra|free|a\s+few)/i,
  /\byou\s*(?:'ve|’ve|have)\s+(?:just\s+)?(?:bought|purchased|been\s+(?:given|credited|charged|refunded))\b/i,
  /\b(?:has|have|was|were)\s+been\s+(?:purchased|bought|signed|minted|transferred|credited|added\s+to\s+your\s+(?:inventory|account|wallet))\b/i,
  /\b(?:purchase|payment|transaction)\s+(?:complete|completed|successful|confirmed|signed|sent|approved)\b/i,
  /\b(?:i|we)\s+(?:can|will|'ll|ll)\s+(?:sign|buy\s+it\s+for\s+you|spend\s+your|charge\s+you|send\s+(?:you\s+)?(?:coins|funds))\b/i,
];
export function claimsForbiddenAction(text: string): boolean {
  return FALSE_CLAIM_RES.some((re) => re.test(text));
}

/** Secrets that must never be echoed: the configured API key, key-shaped strings, long base58 blobs. */
export function leaksSecrets(text: string, apiKey: string | undefined): boolean {
  if (apiKey && apiKey.length >= 8 && text.includes(apiKey)) return true;
  if (/\bsk-[A-Za-z0-9_-]{10,}/.test(text)) return true;
  if (/\b[1-9A-HJ-NP-Za-km-z]{43,90}\b/.test(text)) return true; // wallet keys / seed-like blobs
  if (/\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/.test(text) && /seed|phrase|mnemonic|recovery/i.test(text)) return true;
  return false;
}

/** Word shingles used to detect the system prompt being echoed back. */
export function shingles(text: string, size = 6): Set<string> {
  const words = norm(text).split(' ').filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + size <= words.length; i++) out.add(words.slice(i, i + size).join(' '));
  return out;
}
export function echoesShingles(text: string, secret: Set<string>, size = 6): boolean {
  if (!secret.size) return false;
  const words = norm(text).split(' ').filter(Boolean);
  for (let i = 0; i + size <= words.length; i++) if (secret.has(words.slice(i, i + size).join(' '))) return true;
  return false;
}

/** Safe reply built only from trusted action data. Used when the model's own text cannot be trusted. */
export function templatedReply(actions: AiAction[]): string {
  const parts: string[] = [];
  for (const a of actions) {
    switch (a.type) {
      case 'navigate':
        parts.push(`Heading to ${a.label}, about ${Math.round(a.distance)} m away. You will walk there normally.`);
        break;
      case 'open_shop':
        parts.push('The shop is open.');
        break;
      case 'show_items':
        parts.push('Shop items: ' + a.items.map((i) => `${i.name} (${i.price} coins)`).join(', ') + '.');
        break;
      case 'purchase_proposal':
        parts.push(
          `Purchase proposal: ${a.name} for ${a.price} coins${a.canAfford ? '' : ' (you cannot afford it yet)'}. Nothing is bought until you press Confirm.`,
        );
        break;
      case 'mission_offer':
        parts.push(`Mission offer: "${a.offer.title}" (about ${a.offer.estimatedMinutes} min, reward: ${a.offer.reward.label}). Accept it to start.`);
        break;
      case 'players':
        parts.push(a.players.length ? `Players online: ${a.players.map((p) => p.name).join(', ')}.` : 'Nobody else is around right now.');
        break;
      case 'locations':
        parts.push('Places in town: ' + a.locations.map((l) => l.name).join(', ') + '.');
        break;
    }
  }
  if (!parts.length) {
    return 'I can show where places are, walk you there, open the shop, prepare purchases for you to confirm, find missions, and list who is online. What would you like?';
  }
  return cleanReply(parts.join(' '));
}
