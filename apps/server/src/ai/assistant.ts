import { AI_MESSAGE_MAX_LENGTH } from '@pixels/shared';
import type { AiAction, AiErrorResponse, AiGameApi, AiResponse } from '@pixels/shared';
import type { Assistant, AssistantConfig } from './contract';
import { amountsMatchFacts, claimsForbiddenAction, echoesShingles, leaksSecrets, templatedReply, type TurnFacts } from './guard';
import { DailyQuota, RateLimiter } from './limits';
import { ConversationMemory } from './memory';
import { PROMPT_SHINGLES, buildSystemPrompt } from './prompt';
import { AnthropicProvider } from './providers/anthropic';
import { RulesProvider } from './providers/rules';
import { ProviderError, type AiProvider, type ProviderMessage } from './providers/types';
import { REFUSALS, REFUSAL_INTERPRETATION, REFUSAL_PLAN, classifyUnsafe } from './safety';
import { cleanInline, cleanReply, normalizeMessage, redactEmails, truncate } from './text';
import { TOOL_DEFINITIONS, ToolRunner, derivePlan, deriveInterpretation, type ToolOutcome } from './tools';

export const MAX_TOOL_ROUNDS = 4;
export const MAX_CALLS_PER_ROUND = 8;
export const MAX_REPLY_CHARS = 600;
const DEFAULT_MODEL = 'claude-sonnet-4-5';

/** Test seams. Production code only passes `fetch` (through createAssistant). */
export interface AssistantDeps {
  fetch?: typeof fetch;
  /** replace the Anthropic provider (scripted providers in tests) */
  anthropic?: AiProvider;
  /** replace the offline provider factory */
  rules?: (api: AiGameApi) => AiProvider;
}

const finite = (n: unknown, dflt: number) => (typeof n === 'number' && Number.isFinite(n) ? n : dflt);

function warn(msg: string): void {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
  console.warn(`[ai] ${msg}`);
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

interface Conversation {
  text: string;
  interpretation?: string;
  plan?: string[];
  runner: ToolRunner;
}

function mapProviderError(e: unknown): AiErrorResponse {
  if (e instanceof ProviderError) {
    if (e.kind === 'timeout') return { error: 'The assistant took too long to answer. Please try again.', code: 'timeout' };
    if (e.kind === 'rate_limited') return { error: 'The assistant is busy right now. Please try again shortly.', code: 'rate_limited', retryAfterSec: e.retryAfterSec ?? 30 };
  }
  return { error: 'The assistant is unavailable right now. Please try again later.', code: 'unavailable' };
}

/** "INTERPRETATION: ..." first line of the model's final answer */
function splitInterpretation(text: string): { interpretation?: string; reply: string } {
  const m = /^\s*INTERPRETATION:[ \t]*([^\n]*)\n?([\s\S]*)$/i.exec(text);
  if (!m) return { reply: text };
  return { interpretation: m[1].trim(), reply: m[2].trim() };
}

/** keep at most one of each repeatable display action; purchase proposals are unique per item */
function dedupeActions(actions: AiAction[]): AiAction[] {
  const seen = new Set<string>();
  const out: AiAction[] = [];
  for (const a of actions) {
    const key = a.type === 'purchase_proposal' ? `purchase:${a.itemId}` : a.type === 'mission_offer' ? `mission:${a.offer.offerId}` : a.type;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out.slice(0, 8);
}

export class AssistantCore implements Assistant {
  private readonly cfg: Required<Pick<AssistantConfig, 'provider' | 'model' | 'timeoutMs' | 'dailyLimit' | 'ratePerMinute'>> & { apiKey?: string; baseUrl?: string };
  private readonly anthropic: AiProvider | null;
  private readonly rulesFactory: (api: AiGameApi) => AiProvider;
  private readonly memory = new ConversationMemory(6, 30 * 60_000, 2000);
  private readonly rate: RateLimiter;
  private readonly quota: DailyQuota;

  constructor(config: AssistantConfig, deps: AssistantDeps = {}) {
    const provider = config.provider === 'anthropic' || config.provider === 'rules' || config.provider === 'auto' ? config.provider : 'auto';
    this.cfg = {
      provider,
      apiKey: typeof config.apiKey === 'string' && config.apiKey.trim() ? config.apiKey.trim() : undefined,
      model: typeof config.model === 'string' && config.model.trim() ? config.model.trim() : DEFAULT_MODEL,
      timeoutMs: Math.max(1, Math.floor(finite(config.timeoutMs, 15_000))),
      dailyLimit: Math.max(0, Math.floor(finite(config.dailyLimit, 50))),
      ratePerMinute: Math.max(1, Math.floor(finite(config.ratePerMinute, 8))),
      baseUrl: typeof config.baseUrl === 'string' && config.baseUrl.trim() ? config.baseUrl.trim() : undefined,
    };
    this.rate = new RateLimiter(this.cfg.ratePerMinute);
    this.quota = new DailyQuota(this.cfg.dailyLimit);
    this.rulesFactory = deps.rules ?? ((api) => new RulesProvider(api));
    this.anthropic =
      deps.anthropic ??
      (this.cfg.apiKey && provider !== 'rules'
        ? new AnthropicProvider({ apiKey: this.cfg.apiKey, model: this.cfg.model, timeoutMs: this.cfg.timeoutMs, baseUrl: this.cfg.baseUrl, fetch: deps.fetch })
        : null);
  }

  describe(): { provider: string; model: string | null } {
    const { provider } = this.cfg;
    if (provider === 'rules') return { provider: 'rules', model: null };
    if (provider === 'anthropic') return { provider: this.anthropic ? 'anthropic' : 'anthropic (missing API key)', model: this.cfg.model };
    return this.anthropic ? { provider: 'anthropic (rules fallback)', model: this.cfg.model } : { provider: 'rules', model: null };
  }

  async handle(input: { playerKey: string; message: string; api: AiGameApi; now?: number }): Promise<AiResponse | AiErrorResponse> {
    try {
      return await this.handleInner(input);
    } catch {
      warn('unexpected failure while handling a request');
      return { error: 'The assistant ran into a problem. Please try again.', code: 'unavailable' };
    }
  }

  private async handleInner(input: { playerKey: string; message: string; api: AiGameApi; now?: number }): Promise<AiResponse | AiErrorResponse> {
    const now = typeof input?.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now();
    const playerKey = typeof input?.playerKey === 'string' ? input.playerKey : '';
    if (!playerKey || playerKey.length > 200) return { error: 'Invalid request.', code: 'bad_request' };
    if (typeof input.message !== 'string') return { error: 'Please type a message.', code: 'bad_request' };
    const trimmed = input.message.trim();
    if (!trimmed) return { error: 'Please type a message.', code: 'bad_request' };
    if (trimmed.length > AI_MESSAGE_MAX_LENGTH) return { error: `That message is too long (max ${AI_MESSAGE_MAX_LENGTH} characters).`, code: 'bad_request' };
    const msg = normalizeMessage(trimmed);
    if (!msg) return { error: 'Please type a message.', code: 'bad_request' };
    if (!input.api || typeof input.api !== 'object') return { error: 'The assistant is unavailable right now. Please try again later.', code: 'unavailable' };

    const rl = this.rate.tryAcquire(playerKey, now);
    if (!rl.ok) return { error: 'You are sending messages too quickly. Please wait a moment.', code: 'rate_limited', retryAfterSec: rl.retryAfterSec };
    if (!this.quota.reserve(playerKey, now)) {
      return { error: 'You have used all of your assistant requests for today. They reset at midnight UTC.', code: 'quota_exceeded', retryAfterSec: this.quota.secondsUntilReset(now) };
    }

    try {
      const built = await this.answer(playerKey, msg, input.api, now);
      this.memory.add(playerKey, { user: msg, assistant: built.reply }, now);
      return { ...built, usage: { remainingToday: this.quota.remaining(playerKey, now), limitPerDay: this.cfg.dailyLimit } };
    } catch (e) {
      this.quota.refund(playerKey, now);
      if (e instanceof ProviderError) warn(`provider failure: ${e.kind}`);
      return mapProviderError(e);
    }
  }

  /** choose the provider(s), run the conversation and build the response */
  private async answer(playerKey: string, msg: string, api: AiGameApi, now: number): Promise<Omit<AiResponse, 'usage'>> {
    const unsafe = classifyUnsafe(msg);
    if (unsafe) {
      return {
        reply: REFUSALS[unsafe],
        interpretation: REFUSAL_INTERPRETATION[unsafe],
        plan: REFUSAL_PLAN,
        actions: [],
        provider: 'rules',
      };
    }
    const history = this.memory.get(playerKey, now);
    const seed = (hash(playerKey) ^ Math.floor(now / 1000)) >>> 0;
    const { provider } = this.cfg;

    const useAnthropic = provider === 'anthropic' || (provider === 'auto' && !!this.anthropic);
    if (!useAnthropic) {
      const conv = await this.converse(this.rulesFactory(api), api, msg, history, seed);
      return this.finalize(conv, 'rules');
    }
    if (!this.anthropic) throw new ProviderError('unavailable', 'The AI provider is not configured.');
    try {
      const conv = await this.withDeadline((signal) => this.converse(this.anthropic as AiProvider, api, msg, history, seed, signal));
      return this.finalize(conv, 'anthropic');
    } catch (e) {
      if (provider !== 'auto') throw e;
      warn(`falling back to the offline rules provider (${e instanceof ProviderError ? e.kind : 'error'})`);
      const conv = await this.converse(this.rulesFactory(api), api, msg, history, seed);
      return this.finalize(conv, 'rules (fallback)');
    }
  }

  private async withDeadline<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs * 2);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  /** the tool loop: provider proposes tool calls, the ToolRunner validates and executes them */
  private async converse(provider: AiProvider, api: AiGameApi, msg: string, history: { user: string; assistant: string }[], seed: number, signal?: AbortSignal): Promise<Conversation> {
    const runner = new ToolRunner(api);
    const system = provider.name === 'rules' ? '' : buildSystemPrompt(api);
    const messages: ProviderMessage[] = [];
    for (const t of history) {
      messages.push({ role: 'user', text: t.user });
      messages.push({ role: 'assistant', text: t.assistant, toolCalls: [] });
    }
    messages.push({ role: 'user', text: msg });

    let last = { text: '', toolCalls: [] as { id: string; name: string; input: unknown }[], interpretation: undefined as string | undefined, plan: undefined as string[] | undefined };
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const allowTools = round < MAX_TOOL_ROUNDS;
      const completion = await provider.complete({ system, messages, tools: TOOL_DEFINITIONS, signal, allowTools, seed });
      last = { text: completion.text ?? '', toolCalls: Array.isArray(completion.toolCalls) ? completion.toolCalls : [], interpretation: completion.interpretation, plan: completion.plan };
      if (!last.toolCalls.length || !allowTools) break;
      const requested = last.toolCalls;
      messages.push({ role: 'assistant', text: last.text, toolCalls: requested });
      const results = requested.map((call, i) => {
        // calls beyond the per-round budget are still answered (every tool_use needs a result) but not executed
        const outcome: ToolOutcome = i < MAX_CALLS_PER_ROUND ? runner.run(call.name, call.input) : runner.reject(call.name, 'Too many tool calls in one round; ask for fewer.');
        return { toolCallId: call.id, name: call.name, content: outcome.content, isError: !outcome.ok, data: outcome.data as unknown };
      });
      messages.push({ role: 'tool_results', results });
    }
    return { text: last.text, interpretation: last.interpretation, plan: last.plan, runner };
  }

  /** sanitise and validate everything that goes back to the player */
  private finalize(conv: Conversation, providerLabel: string): Omit<AiResponse, 'usage'> {
    const { runner } = conv;
    const actions = dedupeActions(runner.actions);
    const facts: TurnFacts = runner.facts;
    const parsed = splitInterpretation(conv.text);
    const key = this.cfg.apiKey;

    const fromModel = !providerLabel.startsWith('rules');
    const trusted = (s: string) => !leaksSecrets(s, key) && !(fromModel && echoesShingles(s, PROMPT_SHINGLES)) && amountsMatchFacts(s, facts);

    let reply = cleanReply(parsed.reply, 100_000);
    const suspicious = !reply || !trusted(parsed.reply) || !trusted(reply) || claimsForbiddenAction(reply);
    if (suspicious) reply = templatedReply(actions);
    reply = truncate(redactEmails(reply), MAX_REPLY_CHARS);

    const derivedInterpretation = deriveInterpretation(runner.outcomes);
    const interpRaw = conv.interpretation ?? parsed.interpretation;
    let interpretation = interpRaw ? cleanInline(interpRaw, 160) : '';
    if (!interpretation || !trusted(interpretation)) interpretation = derivedInterpretation;

    const planRaw = conv.plan && conv.plan.length ? conv.plan : derivePlan(runner.outcomes);
    const plan = planRaw
      .map((s) => cleanInline(s, 120))
      .filter((s) => s && trusted(s))
      .slice(0, 6);
    if (!plan.length) plan.push(actions.length ? 'Prepare what you asked for' : 'Answer your question');

    return { reply, interpretation: redactEmails(interpretation), plan, actions, provider: providerLabel };
  }
}
