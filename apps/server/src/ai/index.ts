import type { Assistant, AssistantConfig, CreateAssistant } from './contract';
import { AssistantCore } from './assistant';

/**
 * Creates the AI assistant. Pass `deps.fetch` to inject a fetch implementation (tests, proxies).
 * The API key stays inside this module: it is only ever sent as the x-api-key header of the provider request.
 */
export const createAssistant: CreateAssistant = (config, deps) => new AssistantCore(config, { fetch: deps?.fetch });

export type { Assistant, AssistantConfig };
