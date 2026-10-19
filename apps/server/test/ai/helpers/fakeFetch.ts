/** Fake fetch for the Anthropic provider. Records requests and replays scripted responses. */
export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  rawBody: string;
}

export type Responder = (req: RecordedRequest, signal: AbortSignal | undefined) => Response | Promise<Response>;

export interface FakeFetch {
  fetch: typeof fetch;
  requests: RecordedRequest[];
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown };
export const message = (content: Block[], stop_reason = 'end_turn') =>
  json({ id: 'msg_test', type: 'message', role: 'assistant', model: 'test-model', content, stop_reason, usage: { input_tokens: 10, output_tokens: 10 } });
export const textMessage = (t: string) => message([{ type: 'text', text: t }]);
export const toolMessage = (...uses: { id: string; name: string; input: unknown }[]) => message(uses.map((u) => ({ type: 'tool_use' as const, ...u })), 'tool_use');

/** responders are used in order; the last one repeats */
export function fakeFetch(...responders: Responder[]): FakeFetch {
  const requests: RecordedRequest[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const req: RecordedRequest = { url: String(input), method: init?.method ?? 'GET', headers, body: rawBody ? JSON.parse(rawBody) : undefined, rawBody };
    requests.push(req);
    const r = responders[Math.min(requests.length - 1, responders.length - 1)];
    return r(req, init?.signal ?? undefined);
  };
  return { fetch: impl as typeof fetch, requests };
}

/** a fetch that never settles and ignores the abort signal (worst case for timeouts) */
export const hang: Responder = () => new Promise<Response>(() => undefined);
