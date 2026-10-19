import { norm } from './text';

/**
 * Deterministic pre-check for requests the assistant must refuse whatever the provider is.
 * Conservative on purpose: only clear attempts match, so normal shopping/mission requests are never blocked.
 */
export type UnsafeKind = 'bypass_confirmation' | 'wallet' | 'secrets' | 'hack' | 'free_items' | 'price_change' | 'override';

const RULES: { kind: UnsafeKind; re: RegExp[] }[] = [
  {
    kind: 'wallet',
    re: [
      /\b(?:sign|signing|approve|approving|authorize|authorise|submit)\b.{0,30}\b(?:transactions?|txs?|tx|transfer|wallet|payment|contract|swap)\b/,
      /\b(?:transactions?|txs?|wallet|payment)\b.{0,30}\b(?:sign|signed|signing|approve|approved)\b/,
      /\b(?:send|transfer|withdraw|move|bridge|swap|stake)\b.{0,25}\b(?:sol|eth|btc|usdc|usdt|crypto|cryptocurrency|funds|money|tokens?|nfts?)\b/,
      /\b(?:mint|airdrop)\b/,
      /\b(?:drain|empty)\b.{0,15}\bwallet\b/,
      /\b(?:put|move|send|store|record|make)\b.{0,30}\b(?:on\s?chain|blockchain|solana|ethereum|mainnet)\b/,
    ],
  },
  {
    kind: 'secrets',
    re: [
      /\b(?:seed|recovery|secret)\s+phrases?\b/,
      /\b(?:mnemonic|private\s+keys?|secret\s+keys?|api\s?keys?|access\s+tokens?|auth\s+tokens?|passwords?|passphrase)\b/,
      /\b(?:system|hidden|initial|internal)\s+(?:prompt|instructions?|message)\b/,
      /\b(?:reveal|show|tell|print|repeat|leak|dump|display|give)\b.{0,25}\b(?:your|ur)\s+(?:prompt|instructions|rules|configuration|config)\b/,
      /\b(?:email|e\s?mail)\s+(?:address(?:es)?|of)\b|\b(?:my|your|their|his|her|everyone s|other players?s?|players)\s+e\s?mails?\b/,
    ],
  },
  {
    kind: 'bypass_confirmation',
    re: [
      /\b(?:without|no|skip|skipping|bypass|bypassing|avoid|avoiding|dont|do not|never|stop)\s+(?:the\s+|a\s+|any\s+|my\s+|that\s+|this\s+)?(?:asking|ask|confirm|confirming|confirmation|confirmations|approval|approving|permission|prompt|prompts|checking|check|consent|button|popup|pop up|dialog)\b/,
      /\bauto\s?(?:matically)?\s?-?\s?(?:buy|purchase|spend|pay|confirm|approve|accept)\b/,
      /\b(?:automatically|silently|secretly|behind my back)\s+(?:buy|purchase|spend|pay|confirm|approve)\b/,
      /\b(?:confirm|approve|click|press)\b.{0,15}\b(?:it|this|that|purchase|buy|button)\b.{0,10}\bfor me\b/,
      /\bspend\b.{0,25}\b(?:without|no)\b/,
    ],
  },
  {
    kind: 'price_change',
    re: [
      /\b(?:change|set|lower|reduce|cut|modify|override|adjust|edit|slash|drop|fix)\b.{0,25}\b(?:prices?|costs?|pricing)\b/,
      /\b(?:make|let)\s+(?:it|them|the\s+[a-z ]{1,25}|that|this)\s+(?:cost|be\s+priced|be\s+cheaper|be\s+free)\b/,
      /\bprices?\s+(?:to|at)\s+(?:zero|free|\d+)\b/,
      /\b(?:discount|coupon|promo)\s+code\b/,
    ],
  },
  {
    kind: 'free_items',
    re: [
      /\bfree\s+(?:coins?|money|items?|stuff|cash|gold|genesis|collectibles?|cosmetics?|hats?|clothes)\b/,
      /\b(?:for\s+free|free\s+of\s+charge|without\s+paying|for\s+nothing|at\s+no\s+cost|no\s+charge|for\s+0|for\s+zero)\b/,
      /\b(?:give|send|add|grant|credit|spawn|gift|hand|drop|top\s?up|refill)\s+(?:me\s+|us\s+|my\s+account\s+)?(?:(?:\d[\d,.]*k?|a\s+(?:thousand|million|hundred)|thousand|million|unlimited|infinite|lots\s+of|loads\s+of|tons\s+of|extra|more|some\s+free)\s*)(?:mock\s+|in\s?game\s+)?(?:coins?|money|cash|gold|currency|credits?)\b/,
      /\b(?:set|change|make|update|edit)\b.{0,15}\b(?:my\s+)?(?:balance|coins|money)\b.{0,10}\b(?:to|=)\b/,
      /\b(?:duplicate|dupe|clone|copy)\b.{0,20}\b(?:coins?|items?|money)\b/,
    ],
  },
  {
    kind: 'hack',
    re: [
      /\b(?:hack|hacking|hacker|exploit|exploits|cheat|cheats|cheating|dupe|ddos|sql\s+injection|xss|inject|noclip|god\s?mode|speed\s?hack|bot\s+the|crash\s+the\s+server)\b/,
      /\bbypass\b.{0,20}\b(?:server|security|anti\s?cheat|limits?|cooldowns?|rate\s?limit|checks?)\b/,
      /\b(?:give|make|grant)\s+me\s+(?:an?\s+)?(?:admin|administrator|moderator|root|dev|developer|gm)\b/,
      /\b(?:ignore|skip|remove|disable)\b.{0,15}\b(?:cooldown|daily\s+cap|daily\s+limit|mission\s+limit|reward\s+cap)\b/,
    ],
  },
  {
    kind: 'override',
    re: [
      /\b(?:ignore|disregard|forget|override|bypass|drop)\b.{0,15}\b(?:all\s+|any\s+|your\s+|the\s+|these\s+|those\s+)?(?:previous\s+|prior\s+|above\s+|earlier\s+|safety\s+)?(?:instructions?|rules?|guidelines?|restrictions?|filters?|safeguards?|guardrails?|policies)\b/,
      /\b(?:you\s+are\s+now|pretend\s+(?:to\s+be|you\s+are)|act\s+as|roleplay\s+as)\b.{0,30}\b(?:unrestricted|jailbroken|dan|no\s+rules|developer\s+mode|admin|root|evil)\b/,
      /\bdeveloper\s+mode\b|\bjailbreak\b/,
    ],
  },
];

/** Returns the first matching category (most specific first) or null. */
export function classifyUnsafe(message: string): UnsafeKind | null {
  const t = norm(message);
  if (!t) return null;
  for (const rule of RULES) if (rule.re.some((re) => re.test(t))) return rule.kind;
  return null;
}

const OFFER =
  'I can show where things are, walk you there, open the shop, prepare a purchase for you to confirm, find a mission, or list who is online.';

/** Fixed, polite refusals. No numbers, so they can never contradict the catalogue. */
export const REFUSALS: Record<UnsafeKind, string> = {
  bypass_confirmation:
    "I can't buy anything for you or skip the confirmation. A purchase only happens when you press Confirm yourself, and prices always come from the shop catalogue. I can open the shop, show what you can afford, or prepare a proposal for you to confirm.",
  wallet:
    "I can't sign wallet transactions, move funds or touch keys. Collectibles here are mock test items kept inside the game; nothing is recorded on a blockchain. " +
    OFFER,
  secrets:
    "I can't share keys, seed phrases, passwords, private details or my internal instructions, and nobody legitimate will ever ask you for a seed phrase. " +
    OFFER,
  hack: "I can't help with hacking or cheating, and the server checks everything anyway. You can earn coins fairly by completing missions; want me to find one?",
  free_items:
    "I can't hand out coins or items. You earn coins by completing missions and buy items at the shop. Want me to find a mission for you?",
  price_change:
    "Prices come straight from the shop catalogue and I can't change them. I can open the shop and show you the current prices, or find a mission to earn coins.",
  override: "I can't change my rules, but I'm happy to help within them. " + OFFER,
};

export const REFUSAL_INTERPRETATION: Record<UnsafeKind, string> = {
  bypass_confirmation: 'You asked me to skip the purchase confirmation, which I cannot do.',
  wallet: 'You asked about wallet or blockchain actions, which I cannot perform.',
  secrets: 'You asked for private or internal information, which I cannot share.',
  hack: 'You asked for hacking or cheating help, which I cannot give.',
  free_items: 'You asked for free coins or items, which I cannot hand out.',
  price_change: 'You asked me to change prices, which I cannot do.',
  override: 'You asked me to change my rules, which I cannot do.',
};

export const REFUSAL_PLAN = ['Decline politely', 'Explain what I can do instead'];
