import type { AiGameApi, MissionType, ShopItemView } from '@pixels/shared';
import { REFUSALS, REFUSAL_INTERPRETATION, REFUSAL_PLAN, classifyUnsafe } from '../safety';
import { cleanInline } from '../text';
import type { LocationRow, ToolData, ToolName } from '../tools';
import type { AiProvider, ProviderCompletion, ProviderMessage, ProviderRequest, ProviderToolCall, ProviderToolResult } from './types';
import { buildProposal, makeRng, missionOrder, type MissionEnv, type MissionWish } from './rules-missions';
import { classify, compass, type Intent } from './rules-nlu';

/**
 * Offline, deterministic "model". It reads the player's message, decides which allowlisted tools to call
 * and writes the final text from the tool results. Because it speaks the same tool-call protocol as the
 * Anthropic provider, everything it does flows through the same validation and execution path.
 */

const CAPABILITIES =
  'I can tell you where places are, walk you there, open the shop and prepare purchases for you to confirm, find you a mission or treasure hunt, and show who is online. Try "Take me to the shop" or "I\'m bored".';

type Call = [ToolName, Record<string, unknown>];
type Done = Pick<ProviderCompletion, 'interpretation' | 'plan'>;

interface RoundView {
  calls: ProviderToolCall[];
  results: ProviderToolResult[];
}
interface View {
  userText: string;
  lastAssistantText: string | null;
  rounds: RoundView[];
  data: ToolData[];
}

function readView(messages: ProviderMessage[]): View {
  let lastUser = -1;
  for (let i = 0; i < messages.length; i++) if (messages[i].role === 'user') lastUser = i;
  const first = lastUser >= 0 ? messages[lastUser] : null;
  const userText = first && first.role === 'user' ? first.text : '';
  let lastAssistantText: string | null = null;
  for (let i = lastUser - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.text.trim()) {
      lastAssistantText = m.text;
      break;
    }
  }
  const rounds: RoundView[] = [];
  for (let i = lastUser + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const next = messages[i + 1];
    rounds.push({ calls: m.toolCalls, results: next && next.role === 'tool_results' ? next.results : [] });
    i++;
  }
  const data = rounds.flatMap((r) => r.results.map((x) => x.data as ToolData | undefined).filter((d): d is ToolData => !!d && typeof d === 'object'));
  return { userText, lastAssistantText, rounds, data };
}

type OkData<T extends ToolName> = Extract<ToolData, { tool: T; ok: true }>;
const okOf = <T extends ToolName>(data: ToolData[], tool: T): OkData<T> | undefined => data.find((d) => d.tool === tool && d.ok) as OkData<T> | undefined;
const errOf = (data: ToolData[], tool: ToolName): string | undefined => {
  const d = data.find((x) => x.tool === tool && !x.ok);
  return d && !d.ok ? d.error : undefined;
};
const allOk = <T extends ToolName>(data: ToolData[], tool: T): OkData<T>[] => data.filter((d) => d.tool === tool && d.ok) as OkData<T>[];

const sentence = (s: string) => {
  const t = cleanInline(s, 240).trim();
  return !t ? '' : /[.!?]$/.test(t) ? t : t + '.';
};
const firstSentence = (s: string, max: number) => cleanInline(s.split(/(?<=[.!?])\s/)[0] ?? s, max).replace(/[.!?]+$/, '');
const metres = (n: number) => `${Math.round(n)} m`;
const names = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]);
const typeLabel = (t: string) => (t === 'treasure_hunt' ? 'treasure hunt' : t === 'visit_location' ? 'visit mission' : t === 'delivery' ? 'delivery' : t.replace(/_/g, ' '));
const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

const FAR_ERR = /far|reach|near|distance|closer|range|walk|away/i;
const FATAL_MISSION_ERR = /daily|cap|already|active|in progress|one mission|limit/i;
const COOLDOWN_ERR = /cooldown|wait|too soon|recently|again in|try again/i;
const TOO_FAR_ERR = /too far|at most|cover at most|cannot be reached/i;
const TOO_CLOSE_ERR = /too close|too short|too near|at least|minimum/i;

export class RulesProvider implements AiProvider {
  readonly name = 'rules';

  constructor(private readonly api: AiGameApi) {}

  async complete(req: ProviderRequest): Promise<ProviderCompletion> {
    try {
      return this.run(req);
    } catch {
      return { text: "I'm not sure I understood that. " + CAPABILITIES, toolCalls: [], interpretation: 'Unclear request.', plan: ['Show what I can do'] };
    }
  }

  private run(req: ProviderRequest): ProviderCompletion {
    const v = readView(req.messages);
    const unsafe = classifyUnsafe(v.userText);
    if (unsafe) return say(REFUSALS[unsafe], { interpretation: REFUSAL_INTERPRETATION[unsafe], plan: REFUSAL_PLAN });
    const intent = classify(v.userText, this.api, v.lastAssistantText);
    return this.respond(intent, v, req.seed ?? 0);
  }

  private respond(intent: Intent, v: View, seed: number): ProviderCompletion {
    const first = v.rounds.length === 0;
    switch (intent.kind) {
      case 'thanks':
        return say("You're welcome! Anything else? " + CAPABILITIES, { interpretation: 'You are saying thanks.', plan: ['Say you are welcome'] });
      case 'help':
        return say(intent.greeting ? "Hi! I'm Pixel Guide. " + CAPABILITIES : "I'm Pixel Guide. " + CAPABILITIES, { interpretation: 'You want to know what I can do.', plan: ['Explain what I can do'] });
      case 'fallback':
        return say("I'm not sure I understood that. " + CAPABILITIES, { interpretation: 'I could not match your request to something I can do.', plan: ['Show what I can do'] });
      case 'players':
        if (first) return calls(v, [['find_players', {}]]);
        return this.playersReply(v, false);
      case 'social':
        if (first) return calls(v, [['find_players', {}]]);
        return this.playersReply(v, true);
      case 'collectible':
        if (first) return calls(v, [['get_player_context', {}], ['list_shop_items', {}]]);
        return this.collectibleReply(v);
      case 'quests_info':
        if (first) return calls(v, [['list_available_quests', {}]]);
        return this.questsReply(v);
      case 'locations':
        if (first) return calls(v, [['list_locations', {}]]);
        return this.locationsReply(v);
      case 'status':
        if (first) return calls(v, [['get_player_context', {}]]);
        return this.statusReply(v);
      case 'navigate':
      case 'where':
        return this.placeFlow(intent, v);
      case 'shop_open':
      case 'shop_list':
        return this.shopFlow(intent, v);
      case 'buy':
        return this.buyFlow(intent.items, v);
      case 'mission':
        return this.missionFlow(intent, v, seed);
    }
  }

  /* ------------------------------------------------------------------ places */

  private placeFlow(intent: Extract<Intent, { kind: 'navigate' | 'where' }>, v: View): ProviderCompletion {
    const first = v.rounds.length === 0;
    const { hit } = intent;
    if (!hit) {
      if (first) return calls(v, [['list_locations', {}]]);
      const locs = okOf(v.data, 'list_locations')?.locations ?? [];
      const q = cleanInline(intent.query, 40);
      return say(
        `I don't know a place called "${q}". ${locs.length ? `I can show you: ${names(locs.map((l) => l.name))}.` : ''} Where would you like to go?`.trim(),
        { interpretation: `You asked about "${q}", which is not a place I know.`, plan: ['Look up the place', 'List the places I do know'] },
      );
    }
    if (first) {
      return calls(v, [['find_location', { query: intent.query.slice(0, 80) }], intent.kind === 'navigate' ? ['navigate_to', { locationId: hit.id }] : ['get_player_context', {}]]);
    }
    if (intent.kind === 'navigate') {
      const nav = okOf(v.data, 'navigate_to');
      const interpretation = `You want to go to ${hit.name}.`;
      if (!nav) {
        const why = errOf(v.data, 'navigate_to');
        return say(`Sorry, I can't guide you to ${hit.name}${why ? ': ' + sentence(why) : '.'}`, { interpretation, plan: [`Find "${hit.name}"`, 'Check the route (failed)'] });
      }
      const a = nav.action;
      const pos = this.safeContext();
      const dir = pos ? ` to the ${compass(pos.x, pos.z, a.x, a.z)}` : '';
      const lead = intent.teleport ? "I can't teleport you, but " : '';
      const text =
        a.distance < 4
          ? `You're already at ${a.label}. ${sentence(hit.description)}`.trim()
          : `${lead}${lead ? 'h' : 'H'}eading to ${a.label}, about ${metres(a.distance)}${dir}. You'll walk there normally, no teleporting.`;
      return say(text, { interpretation, plan: [`Find "${hit.name}" → walk there with you`] });
    }
    const ctx = okOf(v.data, 'get_player_context')?.context;
    const interpretation = `You are asking where ${hit.name} is.`;
    const plan = [`Find "${hit.name}"`, 'Tell you where it is and offer to walk you there'];
    if (hit.distance < 4) return say(`You're right at ${hit.name} already. ${sentence(hit.description)}`, { interpretation, plan });
    const dir = ctx ? ` to the ${compass(ctx.x, ctx.z, hit.x, hit.z)}` : '';
    return say(`${hit.name} is about ${metres(hit.distance)}${dir} of you. ${sentence(hit.description)} Say "take me there" and I'll walk you over.`, { interpretation, plan });
  }

  /* ------------------------------------------------------------------ shop */

  private shopFlow(intent: Extract<Intent, { kind: 'shop_open' | 'shop_list' }>, v: View): ProviderCompletion {
    const first = v.rounds.length === 0;
    const listing = intent.kind === 'shop_list';
    const openIt = !listing || (intent.kind === 'shop_list' && !intent.focus.length && !intent.notFound);
    if (first) {
      return calls(v, listing ? [...(openIt ? [['open_shop', {}] as Call] : []), ['list_shop_items', {}], ['get_player_context', {}]] : [['open_shop', {}]]);
    }
    const shop = this.safeFind('shop');
    const shopName = shop?.name ?? 'the shop';
    const opened = !!okOf(v.data, 'open_shop');
    const openErr = errOf(v.data, 'open_shop');
    const navigated = v.rounds.some((r) => r.calls.some((c) => c.name === 'navigate_to'));
    if (!opened && openErr && FAR_ERR.test(openErr) && !navigated && shop) {
      return calls(v, [['navigate_to', { locationId: shop.id }]]);
    }
    const walking = !!okOf(v.data, 'navigate_to');
    const walkNote = !opened && walking ? ` ${sentence(openErr ?? 'The shop is out of reach from here.')} I'm walking you to ${shopName}; ask me to open the shop once you arrive.` : '';

    if (!listing) {
      const interpretation = 'You want to open the shop.';
      if (opened) return say(`Opening ${shopName} for you. Ask "show me what I can buy" to see items and prices.`, { interpretation, plan: ['Open the shop'] });
      if (walking) return say(walkNote.trim(), { interpretation, plan: ['Try to open the shop (too far)', `Walk to ${shopName} with you`] });
      return say(`I couldn't open the shop${openErr ? ': ' + sentence(openErr) : '.'}`, { interpretation, plan: ['Try to open the shop (failed)'] });
    }

    const items = okOf(v.data, 'list_shop_items')?.items ?? [];
    const ctx = okOf(v.data, 'get_player_context')?.context;
    const interpretation = intent.focus.length ? `You are asking about the price of ${names(intent.focus.map((f) => f.name))}.` : 'You want to see what the shop sells and what you can afford.';
    const plan = [...(openIt ? [opened ? 'Open the shop' : walking ? `Walk to ${shopName} with you` : 'Look at the shop'] : []), 'Show items with real prices', 'Check what you can afford'];
    if (!items.length) return say(`I couldn't read the shop catalogue just now.${walkNote}`, { interpretation, plan });

    const parts: string[] = [];
    if (intent.notFound) parts.push("I couldn't match that to a shop item.");
    const focus = intent.focus.map((f) => items.find((i) => i.id === f.id)).filter((i): i is ShopItemView => !!i);
    if (focus.length) {
      for (const f of focus) {
        parts.push(`${f.name} costs ${f.price} coins.`);
        if (ctx) parts.push(f.price <= ctx.coins ? `You have ${ctx.coins} coins, so you can afford it.` : `You have ${ctx.coins} coins, so you are ${f.price - ctx.coins} coins short.`);
      }
    } else {
      parts.push(`Here's what ${shopName} sells: ${items.map((i) => `${i.name} (${i.price} coins)`).join(', ')}.`);
    }
    if (ctx && !focus.length) {
      const affordable = items.filter((i) => i.price <= ctx.coins);
      parts.push(
        affordable.length
          ? `You have ${ctx.coins} coins, enough for ${names(affordable.map((i) => i.name))}.`
          : `You have ${ctx.coins} coins, not enough for any item yet. Missions earn coins.`,
      );
    }
    if (walkNote) parts.push(walkNote.trim());
    parts.push("Tell me which one you'd like and I'll set up a purchase for you to confirm.");
    return say(parts.join(' '), { interpretation, plan });
  }

  private buyFlow(wanted: ShopItemView[], v: View): ProviderCompletion {
    if (v.rounds.length === 0) {
      return calls(v, [...wanted.map((w): Call => ['propose_purchase', { itemId: w.id }]), ['get_player_context', {}]]);
    }
    const ctx = okOf(v.data, 'get_player_context')?.context;
    const proposals = allOk(v.data, 'propose_purchase').map((d) => d.action);
    const failures = v.data.filter((d) => d.tool === 'propose_purchase' && !d.ok);
    const interpretation = `You want to buy ${names(wanted.map((w) => w.name))}. I can only prepare a proposal; you confirm it yourself.`;
    const plan = ['Look up the item in the catalogue', 'Show a purchase proposal with the real price', 'You press Confirm to actually buy'];
    const parts: string[] = [];
    for (const a of proposals) {
      if (a.canAfford || !ctx) parts.push(`I've prepared a proposal for ${a.name} at ${a.price} coins.`);
      else parts.push(`${a.name} costs ${a.price} coins and you have ${ctx.coins} coins, so you're ${a.price - ctx.coins} coins short.`);
    }
    for (const f of failures) if (!f.ok) parts.push(`I couldn't prepare that purchase: ${sentence(f.error)}`);
    if (proposals.some((a) => a.canAfford)) parts.push("Nothing is bought until you press Confirm yourself; I can't buy for you.");
    else if (proposals.length) parts.push('A mission is the way to earn more coins; want me to find one?');
    return say(parts.join(' ') || 'I could not prepare that purchase right now.', { interpretation, plan });
  }

  /* ------------------------------------------------------------------ info */

  private playersReply(v: View, social: boolean): ProviderCompletion {
    const players = okOf(v.data, 'find_players')?.players ?? [];
    const list = players.length
      ? `Online now: ${players
          .slice(0, 8)
          .map((p) => (p.distance === null ? p.name : `${p.name} (about ${metres(p.distance)} away)`))
          .join(', ')}. Say hi in chat or walk over; I can't message anyone for you.`
      : 'Nobody else is in town right now.';
    if (social) {
      return say(
        `Challenges you complete together with another player aren't supported yet, sorry. I can set up a solo treasure hunt, a delivery or a visit mission instead; just ask! ${list}`,
        { interpretation: 'You want a challenge with another player, which is not supported yet.', plan: ['Explain that co-op challenges are not available yet', 'Offer a solo mission', 'List who is online'] },
      );
    }
    return say(`${list}${players.length ? '' : ' When someone joins I can show them here. Want a solo mission meanwhile?'}`, { interpretation: 'You want to know who else is online.', plan: ['Look at who is online'] });
  }

  private collectibleReply(v: View): ProviderCompletion {
    const items = okOf(v.data, 'list_shop_items')?.items ?? [];
    const ctx = okOf(v.data, 'get_player_context')?.context;
    const coll = items.find((i) => i.kind === 'collectible');
    const parts = ['Collectibles in Pixels are mock test items: they live inside the game, are not on any blockchain and have no real-world value.'];
    parts.push(
      coll
        ? `You earn coins by completing missions and spend them at the shop, where the ${coll.name} costs ${coll.price} coins.`
        : 'You earn coins by completing missions and spend them at the shop.',
    );
    if (ctx) parts.push(`You have ${ctx.coins} coins right now.`);
    parts.push(`Ask me to buy it and I'll prepare a proposal for you to confirm, or ask for a mission to earn coins.`);
    return say(parts.join(' '), { interpretation: 'You want to know how to get a test collectible.', plan: ['Check the shop catalogue', 'Explain coins, missions and the shop', 'Make clear it is a mock item'] });
  }

  private questsReply(v: View): ProviderCompletion {
    const quests = okOf(v.data, 'list_available_quests')?.quests ?? [];
    const text = quests.length
      ? `Missions I can offer: ${quests.map((q) => `${typeLabel(q.type)} (${firstSentence(q.description, 110)})`).join('; ')}. Ask for one, like "give me a treasure hunt".`
      : 'No mission types are available right now. Try again in a bit.';
    return say(text, { interpretation: 'You want to know which missions exist.', plan: ['List the mission types'] });
  }

  private locationsReply(v: View): ProviderCompletion {
    const locs = okOf(v.data, 'list_locations')?.locations ?? [];
    return say(`Places in town: ${names(locs.map((l: LocationRow) => l.name))}. Say "take me to" and a place, and I'll walk you there.`, {
      interpretation: 'You want to know what there is to see.',
      plan: ['List the places in town'],
    });
  }

  private statusReply(v: View): ProviderCompletion {
    const c = okOf(v.data, 'get_player_context')?.context;
    if (!c) return say("I couldn't read your status just now.", { interpretation: 'You asked about your status.', plan: ['Check your status (failed)'] });
    const parts = [`You have ${c.coins} coins.`];
    if (c.nearestLocation) parts.push(c.nearestLocation.distance < 4 ? `You're at ${c.nearestLocation.name}.` : `You're near ${c.nearestLocation.name}, about ${metres(c.nearestLocation.distance)} away.`);
    parts.push(c.activeMission ? `Active mission: "${c.activeMission.title}", next: ${c.activeMission.currentObjective}.` : 'No active mission right now.');
    return say(parts.join(' '), { interpretation: 'You asked about your status.', plan: ['Check where you are and what you have'] });
  }

  /* ------------------------------------------------------------------ missions */

  private missionFlow(intent: Extract<Intent, { kind: 'mission' }>, v: View, seed: number): ProviderCompletion {
    const ctx = this.api.getPlayerContext();
    const wish: MissionWish = { type: intent.type, theme: intent.theme, minutes: intent.minutes, target: intent.target };
    const interpretation = describeWish(wish);
    if (ctx.activeMission) {
      return say(
        `You're already on "${ctx.activeMission.title}"; next: ${ctx.activeMission.currentObjective}. Finish or abandon it and I'll find you another one.`,
        { interpretation, plan: ['Check your current mission', 'Suggest finishing it first'] },
      );
    }
    const seedBase = (seed ^ hash(v.userText)) >>> 0;
    const env: MissionEnv = { ctx, locations: this.api.listLocations(), rng: makeRng(seedBase + 1 + v.rounds.length) };
    const order = missionOrder(wish, makeRng(seedBase));
    const attempts = v.rounds.flatMap((r) =>
      r.calls
        .map((c, i) => ({ call: c, result: r.results.find((x) => x.toolCallId === c.id) ?? r.results[i] }))
        .filter((x) => x.call.name === 'propose_mission' && x.result),
    );
    const last = attempts[attempts.length - 1];
    const plan = ['Check where you are in town', `Pick a ${typeLabel(order[0])} near you`, 'Offer it; you decide whether to accept'];

    if (!last) {
      for (const type of order) {
        const proposal = buildProposal(type, wish, env);
        if (proposal) return calls(v, [['propose_mission', proposal as unknown as Record<string, unknown>]], { interpretation, plan });
      }
      return say("I couldn't find a mission that fits right now. Try asking for a delivery, a treasure hunt or a visit.", { interpretation, plan });
    }

    const data = last.result.data as ToolData | undefined;
    if (data && data.tool === 'propose_mission' && data.ok) {
      const o = data.offer;
      const intro =
        intent.type && attempts.length === 1
          ? `Here's your ${typeLabel(o.type)}:`
          : { bored: "Here's something fun:", earn: "Here's a good way to earn coins:", beginner: 'A great first mission:', generic: 'How about this:' }[intent.theme];
      const adapted = attempts.length > 1 ? ' (my first idea was not allowed, so I adjusted it)' : '';
      const lengthNote =
        intent.minutes && Math.abs(o.estimatedMinutes - intent.minutes) >= 1 ? ` The game sets the length from the walking distance, so it can differ from the ${intent.minutes} min you asked for.` : '';
      return say(
        `${intro} "${cleanInline(o.title, 60)}"${adapted}, about ${o.estimatedMinutes} min. Reward: ${cleanInline(o.reward.label, 120)}.${lengthNote} Accept the offer card to start, or ask me for something different.`,
        { interpretation, plan: attempts.length > 1 ? [...plan.slice(0, 2), 'First idea was rejected, adjusted it once', plan[2]] : plan },
      );
    }

    const err = data && !data.ok ? data.error : 'it was rejected';
    const prev = last.call.input as { type?: MissionType; startLocationId?: string; objectiveLocationIds?: string[] };
    if (attempts.length < 2 && !FATAL_MISSION_ERR.test(err)) {
      const avoid = [prev.startLocationId, ...(prev.objectiveLocationIds ?? [])].filter((x): x is string => typeof x === 'string');
      const sameTypeOk = !COOLDOWN_ERR.test(err) && prev.type;
      const tries: { type: MissionType; opts: { avoid?: string[]; far?: boolean; near?: boolean } }[] = [];
      if (sameTypeOk && prev.type) tries.push({ type: prev.type, opts: { avoid, far: TOO_CLOSE_ERR.test(err), near: TOO_FAR_ERR.test(err) } });
      for (const t of order) if (t !== prev.type) tries.push({ type: t, opts: {} });
      for (const t of tries) {
        const proposal = buildProposal(t.type, wish, env, t.opts);
        if (proposal) return calls(v, [['propose_mission', proposal as unknown as Record<string, unknown>]], { interpretation, plan });
      }
    }
    const tip = COOLDOWN_ERR.test(err) ? 'Give it a minute, or ask for a different kind of mission.' : FATAL_MISSION_ERR.test(err) ? 'Check back a bit later.' : 'Ask me for a different kind of mission.';
    return say(`I couldn't set up a mission just now: ${sentence(err)} ${tip}`, { interpretation, plan: [...plan.slice(0, 2), 'The server rejected it', 'Explain why'] });
  }

  /* ------------------------------------------------------------------ small reads */

  private safeContext() {
    try {
      return this.api.getPlayerContext();
    } catch {
      return null;
    }
  }

  private safeFind(q: string) {
    try {
      return this.api.findLocation(q);
    } catch {
      return null;
    }
  }
}

function describeWish(w: MissionWish): string {
  if (w.type === 'delivery') return 'You want a delivery mission.';
  if (w.type === 'treasure_hunt') return `You want a treasure hunt${w.minutes ? ` that takes about ${w.minutes} minutes` : ''}.`;
  if (w.type === 'visit_location') return 'You want to visit somewhere.';
  switch (w.theme) {
    case 'bored':
      return 'You are bored and want something fun to do.';
    case 'earn':
      return 'You want to earn some coins.';
    case 'beginner':
      return 'You are new and want a good first activity.';
    default:
      return 'You are looking for a quest.';
  }
}

function say(text: string, extra: Done = {}): ProviderCompletion {
  return { text, toolCalls: [], ...extra };
}

function calls(v: View, list: Call[], extra: Done = {}): ProviderCompletion {
  const round = v.rounds.length;
  return { text: '', toolCalls: list.map(([name, input], i) => ({ id: `rules_${round}_${i}`, name, input })), ...extra };
}
