import type { AiGameApi, MissionType, ShopItemView } from '@pixels/shared';
import { norm } from '../text';
import type { LocationHit } from '../tools';

/**
 * Natural-language understanding for the offline rules provider: a deterministic classifier over the
 * normalised player message. Place names are resolved through api.findLocation (never a private table).
 */

export type MissionTheme = 'bored' | 'earn' | 'beginner' | 'generic';

export type Intent =
  | { kind: 'help'; greeting: boolean }
  | { kind: 'social' }
  | { kind: 'players' }
  | { kind: 'collectible' }
  | { kind: 'navigate'; query: string; hit: LocationHit | null; teleport: boolean }
  | { kind: 'where'; query: string; hit: LocationHit | null }
  | { kind: 'shop_open' }
  | { kind: 'shop_list'; focus: ShopItemView[]; notFound: boolean }
  | { kind: 'buy'; items: ShopItemView[] }
  | { kind: 'quests_info' }
  | { kind: 'locations' }
  | { kind: 'status' }
  | { kind: 'mission'; type?: MissionType; theme: MissionTheme; minutes?: number; target: LocationHit | null }
  | { kind: 'fallback' };

/* --------------------------------------------------------------------------- vocabulary */

const FILLER = new Set(
  (
    'the a an to my nearest closest nearby local that this please pls now quickly again for me us at in on is are it of there place area spot town pixels around here from just kindly right over back up near next ' +
    'go get find i can you do where how im ill wanna want need would like could should tell show let lets thanks thank so then also and or but first be by what which way route path directions direction looking look its ' +
    'take bring lead guide walk head into towards toward visit or okay ok'
  ).split(' '),
);

const NOT_A_PLACE =
  /\b(?:quests?|missions?|adventures?|treasures?|hunts?|fun|challenges?|something|anything|nothing|games?|earn|coins?|money|players?|people|friends?|someone|anyone|test|collectibles?|items?|stuff|know|work|life|sleep|bed|prices?|cheap|bored)\b/;

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, a: 1 };

const ITEM_ALIASES: Record<string, string[]> = {
  coffee: ['coffee', 'cup of coffee', 'drink', 'latte'],
  explorer_cap: ['cap', 'hat', 'explorer hat', 'red cap', 'explorer cap'],
  round_shades: ['shades', 'sunglasses', 'glasses', 'sunnies', 'round shades'],
  neon_sneakers: ['sneakers', 'shoes', 'trainers', 'kicks', 'neon sneakers'],
  sunset_hoodie: ['hoodie', 'jacket', 'sweater', 'sunset hoodie'],
  genesis_pixel: ['genesis', 'genesis pixel', 'collectible', 'test collectible'],
};
const TOKEN_BLACKLIST = new Set(['pixel', 'test', 'mock', 'items', 'shop', 'store', 'market', 'coins', 'sold']);

/* --------------------------------------------------------------------------- patterns */

const GREETING = /^(?:hi|hello|hey|hiya|yo|hola|howdy|greetings|sup|good (?:morning|afternoon|evening|day))(?: (?:there|pixel|guide|assistant|bot|everyone|all))?$/;
const HELP = /^(?:help|help me|please help|can you help(?: me)?|what can you do|what do you do|what can i ask(?: you)?|how do you work|how does this work|commands|options|menu|who are you|what are you|what is this|how do i play|how to play|instructions|i need help|im lost|i am lost)$/;

const STATUS =
  /\bwhere am i\b|\bhow (?:many|much) (?:coins?|money|gold)\b.{0,20}\b(?:have|got|own)\b|\bhow (?:many|much) (?:coins?|money) do i\b|\bmy (?:coins|balance|money|wallet)\b|\bwhat do i (?:have|own)\b|\bmy inventory\b|\bwhat am i (?:doing|up to)\b|\b(?:my )?current (?:mission|quest|objective)\b|\bmy (?:mission|quest)\b|\bam i (?:broke|rich)\b|\bcheck my\b/;

const SOCIAL_WITH =
  /\b(?:another|other|a|my|some|one)\s+(?:player|friend|person|someone)\b|\b(?:with|alongside|and)\s+(?:a\s+|my\s+|some\s+|other\s+)?(?:friends?|someone|somebody|anyone|others|people|players?|partner|buddy|mate)\b|\b(?:together|co ?op|cooperative|multiplayer|team ?up|duo|pvp|versus|vs|compete|competition|race)\b|\b(?:two|2) players\b/;
const CHALLENGE_WORD = /\b(?:challenges?|quests?|missions?|games?|competition|hunt|race|tasks?|activity|play|compete|contest|duel)\b/;

const PLAYERS =
  /\bwho(?:s| is| are)? (?:online|here|around|playing|in (?:town|the town|the game|the room|pixels))\b|\bwho(?:s| is)? (?:else )?(?:online|here|around)\b|\bfind (?:me )?(?:some |other |any |a few )?(?:players?|people|friends?|someone|somebody|anyone)\b|\b(?:other|online|nearby|active) (?:players?|people|users)\b|\b(?:anyone|anybody|someone|somebody) (?:online|here|around|else|playing|nearby)\b|\bis (?:anyone|anybody|someone) (?:online|here|around)\b|\bplayers? (?:online|nearby|around|here)\b|\bhow many (?:players?|people)\b|\bwho wants? to play\b|\b(?:people|players?) (?:to play|who want)\b|\bplayers list\b/;

const COLLECTIBLE = /\b(?:collectibles?|collectables?|nfts?|genesis|blockchain|on ?chain|crypto|token)\b/;
const BUY_STRONG = /\b(?:buy|purchase|order|checkout|check out|pay for|spend)\b/;
const BUY_SOFT = /\b(?:get me|give me|grab|i want|i wanna|id like|i would like|i need|can i have|could i have|can i get|let me have|ill take|i will take|add)\b/;

const SHOP_OPEN = /\b(?:open|enter|use|access|launch|pull up|bring up|show me)\b(?: up)? (?:the |your |this |a )?(?:pixel )?(?:shop|store|market|kiosk|shopping)\b|\bshop menu\b|\bopen shop\b|^(?:the )?(?:shop|store|market)$/;
const SHOP_LIST =
  /\bwhat (?:can|could|should|do) (?:i|we) (?:buy|afford|purchase)\b|\bwhat (?:is|s) (?:for sale|on sale|available|in (?:the )?(?:shop|store|market)|there to buy)\b|\bwhat (?:do|does) (?:you|the shop|the store|the market|pixel market) (?:sell|have|offer)\b|\bfor sale\b|\bprice list\b|\bwhat can i (?:buy|get)\b|\bshow (?:me )?(?:the )?(?:items|goods|wares|stuff|catalog(?:ue)?|inventory|prices|products|things)\b|\bshow me what\b.{0,20}\b(?:buy|afford|sale|sell)\b|\bbrowse\b|\blist (?:the )?(?:items|shop|prices)\b|\banything to buy\b|\bwhat is there to buy\b|\bafford\b|\bcatalog(?:ue)?\b|\bprices?\b|\bhow much (?:is|are|does|do|for)\b|\bhow expensive\b|\bwhat does .{1,30} cost\b|\bwhat(?:s| is) the price\b/;

const QUESTS_INFO =
  /\b(?:what|which) (?:kinds? |types? |sorts? )?(?:of )?(?:quests?|missions?|challenges?|tasks?) (?:are|do|can|is|exist|there|you)\b|\b(?:list|available|types? of|kinds? of)\b.{0,20}\b(?:quests?|missions?)\b|\b(?:quests?|missions?) (?:are )?(?:available|supported)\b|\bwhat (?:quests?|missions?)\b/;
const LOCATIONS_LIST =
  /\b(?:what|which) (?:places|locations|spots|areas|buildings|landmarks)\b|\b(?:list|show)(?: me)? (?:all |the )?(?:places|locations|buildings|landmarks)\b|\bwhat (?:is|s) there to (?:see|visit)\b|\bwhat can i (?:see|visit)\b|\bpoints? of interest\b|\bwhat (?:is|s) in (?:town|this town|the town|pixels)\b|\bsights?\b|\bmap of\b/;

const MISSION_WORDS =
  /\b(?:quests?|missions?|tasks?|challenges?|jobs?|errands?|deliver\w*|parcels?|packages?|treasures?|hunts?|scavenger|clues?|bored|boring|fun|something to do|anything to do|nothing to do|things to do|activit(?:y|ies)|adventures?|explor\w+|sightsee\w*|earn\w*|coins?|money|rich|cash|beginner|newbie|new here|just started|getting started|get started|first time|tutorial|entertain\w*|keep me busy|what (?:can|should|do) i do|give me something|any ideas)\b/;
const DELIVERY = /\b(?:deliver\w*|parcels?|packages?|errands?|courier|postman)\b/;
const TREASURE = /\b(?:treasures?|hunts?|scavenger|clues?|hidden)\b/;
const VISIT = /\b(?:visit\w*|sightsee\w*|explor\w+|tour|check out|go see)\b/;
const THEME_BEGINNER = /\b(?:beginner|newbie|new here|just started|getting started|get started|first time|tutorial|new to)\b/;
const THEME_EARN = /\b(?:earn\w*|coins?|money|rich|cash|income|reward\w*)\b/;
const THEME_BORED = /\b(?:bored|boring|fun|entertain\w*|nothing to do|adventures?|play|keep me busy)\b/;

const NAV_PATTERNS: RegExp[] = [
  /\b(?:take|bring|lead|guide|walk|escort|teleport|warp|send|get|drive|run|navigate|direct|show|point)\s+(?:me|us|myself)\s+(?:over\s+|back\s+|straight\s+|there\s+)?(?:to|towards|toward|into|at|by)\s+(.+)$/,
  /\bshow\s+(?:me|us)\s+the\s+(?:way|path|route|road|directions?)\s+(?:to|towards|toward)\s+(.+)$/,
  /\b(?:go|head|walk|run|travel|navigate|move|come|get|make my way|find my way)\s+(?:over\s+|back\s+|straight\s+)?(?:to|towards|toward|into)\s+(.+)$/,
  /\b(?:directions?|route|path|way|navigation)\s+(?:to|towards|toward|for)\s+(.+)$/,
  /\bhow\s+(?:do|can|could|would|should|to)\s*(?:i|we)?\s*(?:get|go|walk|travel)\s+(?:to|towards|toward)\s+(.+)$/,
  /\bhow\s+(?:do|can|could|would|should|to)\s*(?:i|we)?\s*reach\s+(.+)$/,
  /\b(?:lets|let us|can we|can i|may i|i wanna|i want to|id like to|i would like to|i need to|i have to|ive got to)\s+(?:go|head|walk|get)\s+(?:over\s+)?(?:to|towards|toward|into)\s+(.+)$/,
  /\b(?:i want to|i wanna|id like to|i would like to|lets|can we|can i|please)\s+visit\s+(.+)$/,
  /\bvisit\s+(.+)$/,
];
const WHERE_PATTERNS: RegExp[] = [
  /\bwheres?\b(?:\s+(?:is|are|can i find|do i find|could i find|would i find|might i find|can i get|can i go|do i go|should i go))?\s+(.+)$/,
  /\bwhich way\s+(?:is|to|for|do i go to)?\s*(.+)$/,
  /\b(?:whats|what is)\s+the\s+(?:way|route|path|best way|quickest way|fastest way)\s+(?:to|towards|toward)\s+(.+)$/,
  /\bhow\s+(?:do|can|could|would|should|to)\s*(?:i|we)?\s*find\s+(.+)$/,
];
const LATE_FIND = /\b(?:find|locate|look for|looking for|search for|show me|point out|i need|i want)\s+(?:me\s+)?(?:the\s+|a\s+|an\s+)?(.+)$/;

const AFFIRM = /^(?:yes|yeah|yep|yup|sure|ok|okay|please|do it|go|lets go|yes please|sure thing|go ahead|please do|yes do it|take me)$/;

/* --------------------------------------------------------------------------- helpers */

const tokens = (s: string) => s.split(' ').filter(Boolean);

export function parseDuration(t: string): number | undefined {
  const m = t.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|a)\s*(?:min|mins|minute|minutes)\b/);
  if (!m) return undefined;
  const n = /^\d/.test(m[1]) ? Number(m[1]) : WORDS[m[1]];
  return n && n >= 1 && n <= 60 ? n : undefined;
}

/** Candidate strings to hand to api.findLocation, best first. */
export function placeCandidates(phrase: string): string[] {
  const toks = tokens(phrase);
  let start = 0;
  let end = toks.length;
  while (start < end && FILLER.has(toks[start])) start++;
  while (end > start && FILLER.has(toks[end - 1])) end--;
  const out: string[] = [];
  const push = (c: string) => {
    if (c && !out.includes(c)) out.push(c);
  };
  push(toks.slice(start, end).join(' '));
  const window = toks.slice(0, 8);
  for (let len = window.length; len >= 1; len--) {
    for (let i = 0; i + len <= window.length; i++) {
      const gram = window.slice(i, i + len);
      if (gram.every((w) => FILLER.has(w) || w.length < 3)) continue;
      if (len === 1 && (FILLER.has(gram[0]) || gram[0].length < 3)) continue;
      push(gram.join(' '));
    }
  }
  return out.slice(0, 14);
}

export function resolveLocation(api: AiGameApi, phrase: string): { hit: LocationHit; query: string } | null {
  for (const q of placeCandidates(phrase)) {
    let hit: LocationHit | null = null;
    try {
      hit = api.findLocation(q);
    } catch {
      hit = null;
    }
    if (hit) return { hit, query: q };
  }
  return null;
}

/** First public location whose name appears in `text` (used to resolve "take me there"). */
export function lastMentionedLocation(api: AiGameApi, text: string | null): LocationHit | null {
  if (!text) return null;
  const n = norm(text);
  let best: { idx: number; name: string } | null = null;
  for (const l of api.listLocations()) {
    const idx = n.indexOf(norm(l.name));
    if (idx >= 0 && (!best || idx < best.idx)) best = { idx, name: l.name };
  }
  return best ? api.findLocation(best.name) : null;
}

function matchItems(t: string, items: ShopItemView[]): ShopItemView[] {
  // derive unique distinctive tokens from item names so new catalogue items work without code changes
  const tokenOwners = new Map<string, Set<string>>();
  for (const it of items) {
    for (const w of tokens(norm(it.name.replace(/\([^)]*\)/g, ' ')))) {
      if (w.length < 5 || TOKEN_BLACKLIST.has(w)) continue;
      (tokenOwners.get(w) ?? tokenOwners.set(w, new Set()).get(w)!).add(it.id);
    }
  }
  const found: { item: ShopItemView; idx: number }[] = [];
  for (const it of items) {
    const aliases = new Set<string>([norm(it.name.replace(/\([^)]*\)/g, ' ')), it.id.replace(/_/g, ' '), ...(ITEM_ALIASES[it.id] ?? [])]);
    for (const [w, owners] of tokenOwners) if (owners.size === 1 && owners.has(it.id)) aliases.add(w);
    let best = -1;
    for (const a of aliases) {
      if (!a) continue;
      const m = new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`).exec(t);
      if (m && (best < 0 || m.index < best)) best = m.index;
    }
    if (best >= 0) found.push({ item: it, idx: best });
  }
  return found.sort((a, b) => a.idx - b.idx).map((f) => f.item);
}

export function compass(fromX: number, fromZ: number, toX: number, toZ: number): string {
  const angle = Math.atan2(toX - fromX, -(toZ - fromZ)); // 0 = north (-z), clockwise
  const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return names[(Math.round(angle / (Math.PI / 4)) + 8) % 8];
}

/* --------------------------------------------------------------------------- classifier */

export function classify(message: string, api: AiGameApi, lastAssistantText: string | null): Intent {
  const t = norm(message);
  if (!t) return { kind: 'help', greeting: false };
  const words = tokens(t);
  if (GREETING.test(t)) return { kind: 'help', greeting: true };
  if (HELP.test(t)) return { kind: 'help', greeting: false };
  if (STATUS.test(t)) return { kind: 'status' };

  const strongBuy = BUY_STRONG.test(t);
  if (SOCIAL_WITH.test(t) && (CHALLENGE_WORD.test(t) || MISSION_WORDS.test(t)) && !/\bfind (?:me )?(?:some )?players?\b/.test(t)) return { kind: 'social' };
  if (PLAYERS.test(t)) return { kind: 'players' };

  let items: ShopItemView[] = [];
  try {
    items = api.listShopItems();
  } catch {
    items = [];
  }
  const mentioned = matchItems(t, items);
  if (COLLECTIBLE.test(t) && !strongBuy) {
    const isQuestion = /^(?:how|what|whats|where|wheres|why|who|can|could|is|are|do|does|tell|explain|about|will)\b/.test(t) || message.includes('?');
    if (isQuestion || !(BUY_SOFT.test(t) && mentioned.length)) return { kind: 'collectible' };
  }

  // "yes" / "take me there" after the assistant offered to walk the player somewhere
  if (words.length <= 3 && AFFIRM.test(t) && lastAssistantText && /take me there|walk you/i.test(lastAssistantText)) {
    const hit = lastMentionedLocation(api, lastAssistantText);
    if (hit) return { kind: 'navigate', query: hit.name, hit, teleport: false };
  }

  // navigation / location questions
  const nav = firstPhrase(NAV_PATTERNS, t);
  if (nav !== null) {
    const teleport = /\b(?:teleport|warp)\b/.test(t);
    const phrase = nav;
    if (/^(?:(?:the|that|this|a)\s+)?(?:there|it|here|that place|that one|the same place|the place)(?:\s+(?:please|now|again))?$/.test(phrase) || phrase === '') {
      const hit = lastMentionedLocation(api, lastAssistantText);
      if (hit) return { kind: 'navigate', query: hit.name, hit, teleport };
    } else if (!NOT_A_PLACE.test(phrase)) {
      const r = resolveLocation(api, phrase);
      return { kind: 'navigate', query: r?.query ?? cleanPhrase(phrase), hit: r?.hit ?? null, teleport };
    }
  }
  const where = firstPhrase(WHERE_PATTERNS, t);
  if (where !== null && !NOT_A_PLACE.test(where) && where) {
    const r = resolveLocation(api, where);
    return { kind: 'where', query: r?.query ?? cleanPhrase(where), hit: r?.hit ?? null };
  }

  // shop
  if (SHOP_OPEN.test(t) && !strongBuy) return { kind: 'shop_open' };
  if (strongBuy && mentioned.length) return { kind: 'buy', items: mentioned.slice(0, 2) };
  if (SHOP_LIST.test(t)) return { kind: 'shop_list', focus: mentioned.slice(0, 2), notFound: false };
  if (BUY_SOFT.test(t) && mentioned.length && !MISSION_WORDS.test(t)) return { kind: 'buy', items: mentioned.slice(0, 2) };
  if (strongBuy) {
    const obj = /\b(?:buy|purchase|order|get)\s+(?:a |an |the |some |my )?(.+)$/.exec(t)?.[1] ?? '';
    const generic = !obj || /^(?:something|anything|stuff|things?|items?|goods|a gift|presents?|cool|nice|new|more)\b/.test(obj);
    return { kind: 'shop_list', focus: [], notFound: !generic };
  }
  if (mentioned.length && words.length <= 4) return { kind: 'shop_list', focus: mentioned.slice(0, 2), notFound: false };

  if (QUESTS_INFO.test(t) && !/\b(?:give|find|create|make|start|offer|suggest)\b/.test(t)) return { kind: 'quests_info' };
  if (LOCATIONS_LIST.test(t) && !MISSION_WORDS.test(t)) return { kind: 'locations' };

  if (MISSION_WORDS.test(t)) {
    const type: MissionType | undefined = DELIVERY.test(t) ? 'delivery' : TREASURE.test(t) ? 'treasure_hunt' : VISIT.test(t) ? 'visit_location' : undefined;
    const theme: MissionTheme = THEME_BEGINNER.test(t) ? 'beginner' : THEME_EARN.test(t) && !type ? 'earn' : THEME_BORED.test(t) ? 'bored' : 'generic';
    let target: LocationHit | null = null;
    if (type === 'visit_location') {
      const m = /\b(?:visit|to|at|near|around)\s+(?:the\s+)?(.+)$/.exec(t);
      if (m && !NOT_A_PLACE.test(m[1])) target = resolveLocation(api, m[1])?.hit ?? null;
    }
    return { kind: 'mission', type, theme, minutes: parseDuration(t), target };
  }

  // late attempts: "find the bakery", "show me the library", or just a place name
  const late = LATE_FIND.exec(t)?.[1];
  if (late && !NOT_A_PLACE.test(late)) {
    const r = resolveLocation(api, late);
    if (r) return { kind: 'where', query: r.query, hit: r.hit };
  }
  if (words.length <= 5 && !NOT_A_PLACE.test(t)) {
    const r = resolveLocation(api, t);
    if (r) return { kind: 'where', query: r.query, hit: r.hit };
  }
  return { kind: 'fallback' };
}

function firstPhrase(patterns: RegExp[], t: string): string | null {
  for (const re of patterns) {
    const m = re.exec(t);
    if (m) return m[1]?.trim() ?? '';
  }
  return null;
}

function cleanPhrase(phrase: string): string {
  const toks = tokens(phrase);
  let start = 0;
  let end = toks.length;
  while (start < end && FILLER.has(toks[start])) start++;
  while (end > start && FILLER.has(toks[end - 1])) end--;
  return toks.slice(start, end).join(' ').slice(0, 40) || phrase.slice(0, 40);
}
