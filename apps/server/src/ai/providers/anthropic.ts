import { z } from 'zod';
import { ProviderError, type AiProvider, type ProviderCompletion, type ProviderMessage, type ProviderRequest, type ProviderToolCall } from './types';

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  baseUrl?: string;
  fetch?: typeof fetch;
  maxTokens?: number;
}

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const MAX_TEXT_CHARS = 8000;

const ResponseSchema = z.object({
  content: z.array(z.looseObject({ type: z.string() })),
  stop_reason: z.string().nullish(),
});
const TextBlock = z.object({ type: z.literal('text'), text: z.string() });
const ToolUseBlock = z.object({ type: z.literal('tool_use'), id: z.string().min(1).max(100), name: z.string().min(1).max(100), input: z.unknown() });

type WireBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
interface WireMessage {
  role: 'user' | 'assistant';
  content: string | WireBlock[];
}

/** Provider-neutral messages -> Anthropic Messages API format (tool_use / tool_result blocks). */
export function toWireMessages(messages: ProviderMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text });
    } else if (m.role === 'assistant') {
      const blocks: WireBlock[] = [];
      if (m.text.trim()) blocks.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input && typeof c.input === 'object' ? c.input : {} });
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '(no content)' }] });
    } else {
      out.push({
        role: 'user',
        content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.toolCallId, content: r.content, ...(r.isError ? { is_error: true } : {}) })),
      });
    }
  }
  return out;
}

function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const n = Number(h);
  return Number.isFinite(n) && n > 0 ? Math.min(3600, Math.ceil(n)) : undefined;
}

class AbortedError extends Error {}

/** free the connection without ever reading (or leaking) an error body */
function discard(res: Response): void {
  try {
    void res.body?.cancel().catch(() => undefined);
  } catch {
    /* ignore */
  }
}

/** Reject as soon as the signal aborts, even if the underlying fetch implementation ignores it. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new AbortedError());
    const onAbort = () => reject(new AbortedError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Anthropic Messages API over plain fetch. The API key lives only in this object and in the request header;
 * errors are mapped to generic ProviderErrors so provider response bodies never reach the player.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  private readonly fetchFn: typeof fetch;
  private readonly url: string;

  constructor(private readonly opts: AnthropicProviderOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.url = `${(opts.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')}/v1/messages`;
  }

  async complete(req: ProviderRequest): Promise<ProviderCompletion> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      max_tokens: this.opts.maxTokens ?? 800,
      system: req.system,
      messages: toWireMessages(req.messages),
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    };
    if (req.allowTools === false) body.tool_choice = { type: 'none' };

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1, this.opts.timeoutMs));
    const onOuterAbort = () => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    const doFetch = this.fetchFn;
    try {
      const res = await raceAbort(
        doFetch(this.url, {
          method: 'POST',
          headers: { 'x-api-key': this.opts.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        controller.signal,
      );
      if (res.status === 429) {
        discard(res);
        throw new ProviderError('rate_limited', 'The AI service is busy.', parseRetryAfter(res.headers.get('retry-after')));
      }
      if (!res.ok) {
        discard(res);
        throw new ProviderError('unavailable', 'The AI service is unavailable.');
      }
      let json: unknown;
      try {
        json = await raceAbort(res.json() as Promise<unknown>, controller.signal);
      } catch (e) {
        if (e instanceof AbortedError) throw e;
        throw new ProviderError('unavailable', 'The AI service returned an unreadable response.');
      }
      return this.parse(json);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (e instanceof AbortedError || controller.signal.aborted) {
        throw new ProviderError('timeout', timedOut ? 'The AI service timed out.' : 'The request was cancelled.');
      }
      throw new ProviderError('unavailable', 'The AI service could not be reached.');
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  private parse(json: unknown): ProviderCompletion {
    const parsed = ResponseSchema.safeParse(json);
    if (!parsed.success) throw new ProviderError('unavailable', 'The AI service returned an unexpected response.');
    let text = '';
    const toolCalls: ProviderToolCall[] = [];
    for (const block of parsed.data.content) {
      const t = TextBlock.safeParse(block);
      if (t.success) {
        text += (text ? '\n' : '') + t.data.text;
        continue;
      }
      const u = ToolUseBlock.safeParse(block);
      if (u.success) toolCalls.push({ id: u.data.id, name: u.data.name, input: u.data.input });
    }
    return { text: text.slice(0, MAX_TEXT_CHARS), toolCalls: toolCalls.slice(0, 32), stopReason: parsed.data.stop_reason ?? undefined };
  }
}
