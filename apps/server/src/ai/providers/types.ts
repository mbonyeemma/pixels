import type { AiToolDefinition } from '@pixels/shared';

/** A tool call requested by a provider. `input` is untrusted and validated by the ToolRunner. */
export interface ProviderToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ProviderToolResult {
  toolCallId: string;
  name: string;
  /** JSON text shown to the model */
  content: string;
  isError: boolean;
  /** structured form, used by the offline rules provider (never sent over the wire) */
  data?: unknown;
}

/** Provider-neutral conversation format; each provider maps it to its own wire format. */
export type ProviderMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ProviderToolCall[] }
  | { role: 'tool_results'; results: ProviderToolResult[] };

export interface ProviderRequest {
  system: string;
  messages: ProviderMessage[];
  tools: AiToolDefinition[];
  signal?: AbortSignal;
  /** false on the last round: the model must answer in text */
  allowTools?: boolean;
  /** per-request entropy so the offline engine varies its suggestions without being random in tests */
  seed?: number;
}

export interface ProviderCompletion {
  text: string;
  toolCalls: ProviderToolCall[];
  /** providers that know how they read the request may say so */
  interpretation?: string;
  plan?: string[];
  stopReason?: string;
}

export interface AiProvider {
  readonly name: string;
  complete(req: ProviderRequest): Promise<ProviderCompletion>;
}

export type ProviderErrorKind = 'unavailable' | 'rate_limited' | 'timeout';

/** Raised by providers. Messages are generic on purpose: provider response bodies are never forwarded. */
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
