import { RpcError, type ParsedTransaction, type SolanaRpc } from './types';

export interface HttpRpcOptions {
  /** per-request timeout */
  timeoutMs?: number;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
  /** reject responses larger than this (a parsed transaction is a few KB) */
  maxBytes?: number;
}

/** Real JSON-RPC client over fetch. Read-only: it only calls getGenesisHash and getTransaction. */
export class HttpSolanaRpc implements SolanaRpc {
  private id = 1;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;

  constructor(
    private readonly url: string,
    opts: HttpRpcOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxBytes = opts.maxBytes ?? 1_000_000;
  }

  /** host only: the URL may carry an API key and must never reach logs */
  get host(): string {
    try {
      return new URL(this.url).host;
    } catch {
      return 'invalid-url';
    }
  }

  private async call(method: string, params: unknown[]): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: this.id++, method, params }),
          signal: ctrl.signal,
        });
      } catch (err) {
        const aborted = (err as { name?: string })?.name === 'AbortError';
        throw new RpcError(aborted ? `RPC ${method} timed out` : `RPC ${method} request failed`);
      }
      if (!res.ok) throw new RpcError(`RPC ${method} answered HTTP ${res.status}`, res.status === 429 || res.status >= 500);
      const text = await res.text();
      if (text.length > this.maxBytes) throw new RpcError(`RPC ${method} response too large`, false);
      let body: { result?: unknown; error?: { code?: number; message?: string } };
      try {
        body = JSON.parse(text);
      } catch {
        throw new RpcError(`RPC ${method} returned invalid JSON`);
      }
      if (body.error) throw new RpcError(`RPC ${method} error ${body.error.code ?? ''}: ${String(body.error.message ?? '').slice(0, 120)}`);
      return body.result ?? null;
    } finally {
      clearTimeout(timer);
    }
  }

  async getGenesisHash(): Promise<string> {
    const r = await this.call('getGenesisHash', []);
    if (typeof r !== 'string') throw new RpcError('RPC getGenesisHash returned an unexpected result');
    return r;
  }

  async getTransaction(signature: string): Promise<ParsedTransaction | null> {
    const r = await this.call('getTransaction', [signature, { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    if (r === null) return null;
    if (typeof r !== 'object') throw new RpcError('RPC getTransaction returned an unexpected result');
    return r as ParsedTransaction;
  }
}
