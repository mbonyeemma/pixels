import type { AiErrorResponse, AiGameApi, AiResponse } from '@pixels/shared';

export interface AssistantConfig {
  /** 'auto' = anthropic when ANTHROPIC_API_KEY is set, otherwise the offline rules provider */
  provider: 'auto' | 'anthropic' | 'rules';
  apiKey?: string;
  model: string;
  timeoutMs: number;
  dailyLimit: number;
  ratePerMinute: number;
  /** base URL override for the Anthropic API (tests / proxies) */
  baseUrl?: string;
}

export interface Assistant {
  /**
   * Handle one player message. Never throws: failures become an AiErrorResponse.
   * `playerKey` is the stable account id (used for rate limits, daily quotas and short conversation memory).
   */
  handle(input: { playerKey: string; message: string; api: AiGameApi; now?: number }): Promise<AiResponse | AiErrorResponse>;
  /** providers actually in use, for the /api/health endpoint */
  describe(): { provider: string; model: string | null };
}

/** Implemented in ./index.ts by the AI module. */
export type CreateAssistant = (config: AssistantConfig, deps?: { fetch?: typeof fetch }) => Assistant;
