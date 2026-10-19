import type { AiGameApi } from '@pixels/shared';
import { AssistantCore } from '../../../src/ai/assistant';
import type { AssistantConfig } from '../../../src/ai/contract';
import type { AiProvider, ProviderCompletion, ProviderRequest, ProviderToolCall } from '../../../src/ai/providers/types';
import { createFakeApi, expectResponse, type FakeApi, type FakeApiOptions } from './fakeApi';

export interface ScriptedProvider extends AiProvider {
  requests: ProviderRequest[];
}

/** A fake model: `handler` decides what each round returns. Everything it asks for goes through the real ToolRunner. */
export function scripted(handler: (req: ProviderRequest, callIndex: number) => ProviderCompletion | Promise<ProviderCompletion>): ScriptedProvider {
  const requests: ProviderRequest[] = [];
  return {
    name: 'scripted',
    requests,
    async complete(req) {
      requests.push(req);
      return handler(req, requests.length - 1);
    },
  };
}

let n = 0;
export const call = (name: string, input: unknown = {}, id?: string): ProviderToolCall => ({ id: id ?? `call_${++n}`, name, input });
export const text = (t: string): ProviderCompletion => ({ text: t, toolCalls: [] });
export const useTools = (...calls: ProviderToolCall[]): ProviderCompletion => ({ text: '', toolCalls: calls });

export const baseConfig = (over: Partial<AssistantConfig> = {}): AssistantConfig => ({
  provider: 'anthropic',
  apiKey: 'sk-ant-test-key-1234567890',
  model: 'test-model',
  timeoutMs: 2000,
  dailyLimit: 100,
  ratePerMinute: 100,
  ...over,
});

let player = 0;
export const nextPlayer = () => `player-${++player}`;

export function scriptedAssistant(handler: Parameters<typeof scripted>[0], over: Partial<AssistantConfig> = {}, apiOpts: FakeApiOptions = {}) {
  const provider = scripted(handler);
  const assistant = new AssistantCore(baseConfig(over), { anthropic: provider });
  const api: FakeApi = createFakeApi(apiOpts);
  const ask = async (message: string, now = 1_700_000_000_000, playerKey = nextPlayer()) => expectResponse(await assistant.handle({ playerKey, message, api: api as AiGameApi, now }));
  return { assistant, provider, api, ask };
}

/** the tool_result entries the scripted model received in its last request */
export function lastToolResults(provider: ScriptedProvider) {
  const last = provider.requests[provider.requests.length - 1];
  const m = last.messages[last.messages.length - 1];
  return m.role === 'tool_results' ? m.results : [];
}
