import { z } from 'zod';
import { MISSION_TYPES } from '@pixels/shared';
import type { AiAction, AiGameApi, AiToolDefinition, MissionOfferView, ShopItemView } from '@pixels/shared';
import { extractCoinAmounts, newFacts, type TurnFacts } from './guard';
import { cleanInline, stripControl } from './text';

/* ------------------------------------------------------------------------------------------------
 * The allowlisted tools. Each maps 1:1 to a method of AiGameApi. Every tool name and every argument is
 * validated with zod (strict objects: unknown keys such as `price`, `reward` or `confirm` are rejected)
 * before the api is touched. Nothing the model produces is executed beyond these calls.
 * ---------------------------------------------------------------------------------------------- */

export const TOOL_NAMES = [
  'get_player_context',
  'find_location',
  'navigate_to',
  'open_shop',
  'list_shop_items',
  'propose_purchase',
  'list_available_quests',
  'propose_mission',
  'find_players',
  'list_locations',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const idString = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be an id made of letters, digits, "_" or "-"');

/** free text: bounded before cleaning (cheap), cleaned, then length-checked */
const freeText = (min: number, max: number) =>
  z
    .string()
    .max(max * 4, `must be at most ${max} characters`)
    .transform((s) => cleanInline(s, max * 2))
    .pipe(z.string().min(min, `must be at least ${min} characters`).max(max, `must be at most ${max} characters`));

const noArgs = z.strictObject({});

export const TOOL_SCHEMAS = {
  get_player_context: noArgs,
  find_location: z.strictObject({ query: freeText(1, 80) }),
  navigate_to: z.strictObject({ locationId: idString }),
  open_shop: noArgs,
  list_shop_items: noArgs,
  propose_purchase: z.strictObject({ itemId: idString }),
  list_available_quests: noArgs,
  propose_mission: z.strictObject({
    title: freeText(3, 60),
    description: freeText(5, 280),
    type: z.enum(MISSION_TYPES),
    startLocationId: idString,
    objectiveLocationIds: z.array(idString).min(1).max(6),
    estimatedMinutes: z.number().finite().min(1).max(15).optional(),
  }),
  find_players: noArgs,
  list_locations: noArgs,
} satisfies Record<ToolName, z.ZodType>;

const EMPTY_OBJECT = { type: 'object', properties: {}, additionalProperties: false } as const;

/** Anthropic tool definitions (JSON Schema). Kept in sync with TOOL_SCHEMAS by a unit test. */
export const TOOL_DEFINITIONS: AiToolDefinition[] = [
  {
    name: 'get_player_context',
    description:
      "Get the requesting player's display name, position, coin balance, nearest location, nearby things, active mission and number of players online. Call it before suggesting missions or purchases.",
    input_schema: { ...EMPTY_OBJECT },
  },
  {
    name: 'find_location',
    description: "Resolve a place name or nickname (e.g. 'bakery', 'the café', 'pond') to a public town location. Returns found=false when unknown.",
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1, maxLength: 80, description: 'Free-text place name or alias.' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'navigate_to',
    description:
      'Make the player WALK to a public location (normal walking, never teleporting). Use the id returned by find_location or list_locations.',
    input_schema: {
      type: 'object',
      properties: { locationId: { type: 'string', maxLength: 40, description: 'Public location id such as "shop" or "bakery".' } },
      required: ['locationId'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_shop',
    description: 'Open the Pixel Market shop window for the player. Fails if the shop is not reachable.',
    input_schema: { ...EMPTY_OBJECT },
  },
  {
    name: 'list_shop_items',
    description: 'List the shop items with their authoritative prices. Use it for every price you mention.',
    input_schema: { ...EMPTY_OBJECT },
  },
  {
    name: 'propose_purchase',
    description:
      'Show the player a purchase PROPOSAL for one shop item. The player must press Confirm in the UI; you can never buy anything, and you cannot set a price.',
    input_schema: {
      type: 'object',
      properties: { itemId: { type: 'string', maxLength: 40, description: 'Item id from list_shop_items, e.g. "explorer_cap".' } },
      required: ['itemId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_available_quests',
    description: 'List the mission types currently supported, with short descriptions and examples.',
    input_schema: { ...EMPTY_OBJECT },
  },
  {
    name: 'propose_mission',
    description:
      'Offer the player a mission. The server validates it and chooses the reward; you only choose the type, the locations, a title and a description. The player decides whether to accept. ' +
      'visit_location: one objective (a public place except the plaza). delivery: startLocationId is a pickup (bakery or post_office) and the single objective a different drop-off. ' +
      'treasure_hunt: 2-4 hidden spot ids; startLocationId can be the nearest public location.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 3, maxLength: 60, description: 'Short friendly title, plain text.' },
        description: { type: 'string', minLength: 5, maxLength: 280, description: 'One or two friendly sentences, plain text. Do not mention reward amounts.' },
        type: { type: 'string', enum: [...MISSION_TYPES] },
        startLocationId: { type: 'string', maxLength: 40 },
        objectiveLocationIds: { type: 'array', items: { type: 'string', maxLength: 40 }, minItems: 1, maxItems: 6 },
        estimatedMinutes: { type: 'number', minimum: 1, maximum: 15, description: 'Rough duration in minutes (informational only).' },
      },
      required: ['title', 'description', 'type', 'startLocationId', 'objectiveLocationIds'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_players',
    description: 'List other players currently online (display names and rough distance only).',
    input_schema: { ...EMPTY_OBJECT },
  },
  {
    name: 'list_locations',
    description: 'List the public town locations (id, name, description, distance from the player).',
    input_schema: { ...EMPTY_OBJECT },
  },
];

/* ------------------------------------------------------------------------------------------------ */

export type PlayerCtx = ReturnType<AiGameApi['getPlayerContext']>;
export type LocationHit = NonNullable<ReturnType<AiGameApi['findLocation']>>;
export type LocationRow = ReturnType<AiGameApi['listLocations']>[number];
export type NavigateAction = Extract<AiAction, { type: 'navigate' }>;
export type PurchaseAction = Extract<AiAction, { type: 'purchase_proposal' }>;
export type QuestRow = ReturnType<AiGameApi['listAvailableQuests']>[number];
export type PlayerRow = ReturnType<AiGameApi['findPlayers']>[number];

/** Structured result of one tool call (consumed by the offline rules provider and by the plan builder). */
export type ToolData =
  | { tool: 'get_player_context'; ok: true; context: PlayerCtx }
  | { tool: 'find_location'; ok: true; found: true; location: LocationHit }
  | { tool: 'find_location'; ok: true; found: false; query: string }
  | { tool: 'navigate_to'; ok: true; action: NavigateAction }
  | { tool: 'open_shop'; ok: true }
  | { tool: 'list_shop_items'; ok: true; items: ShopItemView[] }
  | { tool: 'propose_purchase'; ok: true; action: PurchaseAction }
  | { tool: 'list_available_quests'; ok: true; quests: QuestRow[] }
  | { tool: 'propose_mission'; ok: true; offer: MissionOfferView }
  | { tool: 'find_players'; ok: true; players: PlayerRow[] }
  | { tool: 'list_locations'; ok: true; locations: LocationRow[] }
  | { tool: ToolName | 'unknown'; ok: false; error: string };

export interface ToolOutcome {
  name: string;
  ok: boolean;
  /** JSON string sent back to the model as the tool_result content */
  content: string;
  data: ToolData;
  actions: AiAction[];
  /** human readable plan step, null when the call produced nothing worth showing */
  step: string | null;
}

export const MAX_TOOL_CONTENT_CHARS = 4000;

const round1 = (n: number) => Math.round(n * 10) / 10;

function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message)
    .join('; ')
    .slice(0, 300);
}

/** strings that originate outside the model (player names, api text) are scrubbed before the model sees them */
function scrub(_key: string, value: unknown): unknown {
  return typeof value === 'string' ? cleanInline(value, 300) : value;
}

function toContent(payload: unknown): string {
  let s = JSON.stringify(payload, scrub);
  if (s.length > MAX_TOOL_CONTENT_CHARS) s = JSON.stringify({ truncated: true, note: 'Result too large; ask for something narrower.' });
  return s;
}

const safeName = (v: unknown) => (typeof v === 'string' ? cleanInline(stripControl(v), 40) : typeof v);

/**
 * Runs allowlisted tool calls against the AiGameApi for ONE player request. Never throws; every failure
 * becomes an error outcome that is fed back to the model.
 */
export class ToolRunner {
  readonly outcomes: ToolOutcome[] = [];
  readonly facts: TurnFacts = newFacts();
  private offers = 0;
  private proposedItems = new Set<string>();
  private navigations = 0;

  constructor(private readonly api: AiGameApi) {}

  get actions(): AiAction[] {
    return this.outcomes.flatMap((o) => o.actions);
  }

  run(name: unknown, input: unknown): ToolOutcome {
    const outcome = this.runInner(name, input);
    this.outcomes.push(outcome);
    return outcome;
  }

  /** record a call that was not executed (e.g. over the per-round budget) as an error outcome */
  reject(name: unknown, reason: string): ToolOutcome {
    const known = typeof name === 'string' && (TOOL_NAMES as readonly string[]).includes(name);
    const outcome = this.fail(known ? (name as ToolName) : 'unknown', reason);
    this.outcomes.push(outcome);
    return outcome;
  }

  private fail(tool: ToolName | 'unknown', error: string): ToolOutcome {
    return { name: tool, ok: false, content: toContent({ ok: false, error }), data: { tool, ok: false, error }, actions: [], step: null };
  }

  private runInner(name: unknown, input: unknown): ToolOutcome {
    if (typeof name !== 'string' || !(TOOL_NAMES as readonly string[]).includes(name)) {
      return this.fail('unknown', `Unknown tool "${safeName(name)}". Allowed tools: ${TOOL_NAMES.join(', ')}.`);
    }
    const tool = name as ToolName;
    const args = TOOL_SCHEMAS[tool].safeParse(input ?? {});
    if (!args.success) return this.fail(tool, `Invalid arguments for ${tool}: ${summarizeIssues(args.error)}`);
    try {
      return this.execute(tool, args.data as Record<string, unknown>);
    } catch {
      return this.fail(tool, 'The game could not complete that request. Try something else.');
    }
  }

  /** error text written by the trusted game server: scrubbed, and any amounts it mentions become known facts */
  private apiError(raw: unknown, fallback: string): string {
    const text = typeof raw === 'string' ? cleanInline(raw, 240) : '';
    if (!text) return fallback;
    for (const n of extractCoinAmounts(text)) this.facts.rewardCoins.add(n);
    return text;
  }

  private publicLocations(): LocationRow[] {
    return this.api.listLocations();
  }

  private execute(tool: ToolName, args: Record<string, unknown>): ToolOutcome {
    const api = this.api;
    switch (tool) {
      case 'get_player_context': {
        const context = api.getPlayerContext();
        this.facts.balance = Number.isFinite(context.coins) ? context.coins : null;
        const payload = {
          ok: true,
          player: {
            name: context.displayName,
            x: round1(context.x),
            z: round1(context.z),
            coins: context.coins,
            nearestLocation: context.nearestLocation,
            nearby: context.nearbyInteractables.slice(0, 6),
            activeMission: context.activeMission,
            playersOnline: context.playersOnline,
          },
          note: 'north is -z, south is +z, east is +x',
        };
        return { name: tool, ok: true, content: toContent(payload), data: { tool, ok: true, context }, actions: [], step: 'Check where you are and what you have' };
      }
      case 'find_location': {
        const query = args.query as string;
        const publicIds = new Set(this.publicLocations().map((l) => l.id));
        const hit = api.findLocation(query);
        if (!hit || !publicIds.has(hit.id)) {
          return {
            name: tool,
            ok: true,
            content: toContent({ ok: true, found: false, hint: 'No such place. Use list_locations to see valid places.' }),
            data: { tool, ok: true, found: false, query },
            actions: [],
            step: `Look up "${query}" (not found)`,
          };
        }
        return {
          name: tool,
          ok: true,
          content: toContent({ ok: true, found: true, location: { id: hit.id, name: hit.name, description: hit.description, distance: round1(hit.distance) } }),
          data: { tool, ok: true, found: true, location: hit },
          actions: [],
          step: `Find "${hit.name}"`,
        };
      }
      case 'navigate_to': {
        const id = args.locationId as string;
        if (!this.publicLocations().some((l) => l.id === id)) return this.fail(tool, `Unknown location "${id}". Use find_location or list_locations for valid ids.`);
        if (this.navigations >= 1) return this.fail(tool, 'Only one destination per request. The player is already being guided somewhere.');
        const res = api.navigateTo(id);
        if (!res.ok) return this.fail(tool, this.apiError(res.error, 'Cannot navigate there.'));
        this.navigations++;
        return {
          name: tool,
          ok: true,
          content: toContent({ ok: true, destination: res.action.label, distanceMeters: round1(res.action.distance), note: 'The player will walk there normally.' }),
          data: { tool, ok: true, action: res.action },
          actions: [res.action],
          step: `Walk to ${res.action.label} with you (about ${Math.round(res.action.distance)} m, no teleporting)`,
        };
      }
      case 'open_shop': {
        const res = api.openShop();
        if (!res.ok) return this.fail(tool, this.apiError(res.error, 'The shop cannot be opened right now.'));
        return { name: tool, ok: true, content: toContent({ ok: true, note: 'The shop window is opening for the player.' }), data: { tool, ok: true }, actions: [res.action], step: 'Open the shop' };
      }
      case 'list_shop_items': {
        const items = api.listShopItems();
        for (const it of items) this.facts.items.set(it.id, { name: it.name, price: it.price });
        const payload = {
          ok: true,
          currency: 'mock in-game coins',
          items: items.map((i) => ({ id: i.id, name: i.name, description: i.description, kind: i.kind, price: i.price })),
        };
        return { name: tool, ok: true, content: toContent(payload), data: { tool, ok: true, items }, actions: [{ type: 'show_items', items }], step: 'Show what the shop sells' };
      }
      case 'propose_purchase': {
        const itemId = args.itemId as string;
        const known = api.listShopItems();
        if (!known.some((i) => i.id === itemId)) return this.fail(tool, `Unknown item "${itemId}". Use list_shop_items for valid ids.`);
        if (!this.proposedItems.has(itemId) && this.proposedItems.size >= 3) return this.fail(tool, 'At most three purchase proposals per request.');
        if (this.proposedItems.has(itemId)) return this.fail(tool, `A proposal for "${itemId}" was already shown.`);
        const res = api.proposePurchase(itemId);
        if (!res.ok) return this.fail(tool, this.apiError(res.error, 'That item cannot be proposed.'));
        this.proposedItems.add(itemId);
        const a = res.action;
        this.facts.items.set(a.itemId, { name: a.name, price: a.price });
        return {
          name: tool,
          ok: true,
          content: toContent({
            ok: true,
            proposal: { itemId: a.itemId, name: a.name, price: a.price, canAfford: a.canAfford },
            note: 'A confirmation card was shown to the player. NOTHING was bought; the player must press Confirm.',
          }),
          data: { tool, ok: true, action: a },
          actions: [a],
          step: `Propose buying ${a.name}; you confirm it yourself`,
        };
      }
      case 'list_available_quests': {
        const quests = api.listAvailableQuests();
        for (const n of extractCoinAmounts(JSON.stringify(quests))) this.facts.rewardCoins.add(n);
        return { name: tool, ok: true, content: toContent({ ok: true, quests }), data: { tool, ok: true, quests }, actions: [], step: 'Check which mission types exist' };
      }
      case 'propose_mission': {
        if (this.offers >= 1) return this.fail(tool, 'Only one mission offer per request.');
        const a = args as {
          title: string;
          description: string;
          type: (typeof MISSION_TYPES)[number];
          startLocationId: string;
          objectiveLocationIds: string[];
          estimatedMinutes?: number;
        };
        // Only these fields are forwarded: there is no way to pass a reward, an amount or a reward id.
        const proposal = {
          title: a.title,
          description: a.description,
          type: a.type,
          startLocationId: a.startLocationId,
          objectiveLocationIds: [...a.objectiveLocationIds],
          ...(a.estimatedMinutes !== undefined ? { estimatedMinutes: a.estimatedMinutes } : {}),
        };
        const res = api.createMissionOffer(proposal);
        if (!res.ok) return this.fail(tool, this.apiError(res.error, 'The mission was rejected.'));
        this.offers++;
        const offer = res.offer;
        if (typeof offer.reward.coins === 'number') this.facts.rewardCoins.add(offer.reward.coins);
        for (const n of extractCoinAmounts(offer.reward.label)) this.facts.rewardCoins.add(n);
        return {
          name: tool,
          ok: true,
          content: toContent({
            ok: true,
            offer: {
              title: offer.title,
              type: offer.type,
              estimatedMinutes: offer.estimatedMinutes,
              objectives: offer.objectives,
              reward: offer.reward.label,
            },
            note: 'The offer was shown to the player, who may accept or ignore it. The reward is fixed by the server.',
          }),
          data: { tool, ok: true, offer },
          actions: [{ type: 'mission_offer', offer }],
          step: `Offer the mission "${offer.title}"; you decide whether to accept`,
        };
      }
      case 'find_players': {
        const players = api.findPlayers().slice(0, 20);
        return {
          name: tool,
          ok: true,
          content: toContent({ ok: true, count: players.length, players }),
          data: { tool, ok: true, players },
          actions: [{ type: 'players', players }],
          step: 'See who else is online',
        };
      }
      case 'list_locations': {
        const rows = this.publicLocations();
        return {
          name: tool,
          ok: true,
          content: toContent({ ok: true, locations: rows.map((l) => ({ id: l.id, name: l.name, description: l.description, distance: round1(l.distance) })) }),
          data: { tool, ok: true, locations: rows },
          actions: [{ type: 'locations', locations: rows.map((l) => ({ id: l.id, name: l.name, description: l.description })) }],
          step: 'List the places in town',
        };
      }
    }
  }
}

/** Turn executed outcomes into short, readable plan steps ("Find 'Pixel Market' → walk there with you"). */
export function derivePlan(outcomes: ToolOutcome[]): string[] {
  const steps: string[] = [];
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (!o.ok || !o.step) continue;
    const next = outcomes[i + 1];
    if (o.data.tool === 'find_location' && o.data.ok && 'found' in o.data && o.data.found && next?.ok && next.data.tool === 'navigate_to' && 'action' in next.data) {
      steps.push(`Find "${o.data.location.name}" → walk there with you (about ${Math.round(next.data.action.distance)} m)`);
      i++;
      continue;
    }
    steps.push(o.step);
  }
  return steps.slice(0, 6);
}

export function deriveInterpretation(outcomes: ToolOutcome[]): string {
  const ok = outcomes.filter((o) => o.ok);
  const has = (n: ToolName) => ok.some((o) => o.name === n);
  if (has('navigate_to')) return 'You want to go somewhere in town.';
  if (has('propose_mission')) return 'You are looking for something to do.';
  if (has('propose_purchase')) return 'You want to buy something from the shop.';
  if (has('open_shop') || has('list_shop_items')) return 'You want to see what the shop offers.';
  if (has('find_players')) return 'You want to know who is around.';
  if (has('find_location') || has('list_locations')) return 'You are asking about places in town.';
  if (has('list_available_quests')) return 'You are asking about missions.';
  return 'General question about the game.';
}
