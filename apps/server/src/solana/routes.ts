import { DEVNET_LABEL, type PaymentConfigView, type WalletVerifyResponse } from '@pixels/shared';
import type { Accounts } from '../accounts';
import type { Logger } from '../log';
import { KeyedLimiter } from '../rateLimit';
import type { Clock } from '../util';
import type { SolanaPayments } from './payments';
import { PayConfirmRequestSchema, PayIntentRequestSchema, WalletChallengeRequestSchema, WalletVerifyRequestSchema } from './schemas';
import type { WalletAuth } from './wallet';

export interface RouteContext {
  ip: string;
  authorization: string | undefined;
  /** parse the JSON request body (throws the HTTP layer's own 400/413 errors) */
  readBody: () => Promise<unknown>;
}
export interface RouteResult {
  status: number;
  body: unknown;
  headers?: Record<string, string | number>;
}
export interface SolanaRoutes {
  /** is `${METHOD} ${path}` one of ours? */
  handles(route: string): boolean;
  /** all of our paths, for 405 detection */
  readonly paths: readonly string[];
  handle(route: string, ctx: RouteContext): Promise<RouteResult>;
}

export interface SolanaRoutesDeps {
  accounts: Accounts;
  /** null when payments are disabled */
  payments: SolanaPayments | null;
  wallet: WalletAuth | null;
  clock: Clock;
  log: Logger;
}

const PATHS = ['/api/config', '/api/wallet/challenge', '/api/wallet/verify', '/api/wallet', '/api/pay/intent', '/api/pay/confirm'] as const;
const ROUTES = new Set([
  'GET /api/config',
  'POST /api/wallet/challenge',
  'POST /api/wallet/verify',
  'DELETE /api/wallet',
  'POST /api/pay/intent',
  'POST /api/pay/confirm',
]);

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const trim = (v: unknown) => (typeof v === 'string' ? v.trim() : v);

/** Every error carries the DEVNET label in its text, and every payment/wallet answer carries a `notice`. */
function reply(status: number, body: Record<string, unknown>, headers?: Record<string, string | number>): RouteResult {
  const out: Record<string, unknown> = { ...body, notice: DEVNET_LABEL };
  if (typeof out.error === 'string' && !out.error.includes('DEVNET')) out.error = `${out.error} (${DEVNET_LABEL})`;
  if (typeof out.message === 'string' && !out.message.includes('DEVNET')) out.message = `${out.message} (${DEVNET_LABEL})`;
  return { status, body: out, headers };
}

export function createSolanaRoutes(deps: SolanaRoutesDeps): SolanaRoutes {
  const { payments, wallet } = deps;
  // generous but finite: signing in / linking / paying are human-speed actions
  const challengeLimiter = new KeyedLimiter(10, 10 / 60, deps.clock);
  const verifyLimiter = new KeyedLimiter(10, 10 / 60, deps.clock);
  const intentLimiter = new KeyedLimiter(10, 10 / 60, deps.clock);
  const confirmLimiter = new KeyedLimiter(30, 30 / 60, deps.clock);

  const limited = (lim: KeyedLimiter, key: string): RouteResult | null => {
    if (lim.take(key)) return null;
    const retry = Math.max(1, lim.retryAfterSec(key));
    return reply(429, { error: 'Too many requests. Please wait a moment and try again.', code: 'rate_limited', retryAfterSec: retry }, { 'Retry-After': retry });
  };

  const disabled = (): RouteResult => reply(404, { error: 'Payments are disabled on this server.', code: 'payments_disabled' });
  const blocked = (): RouteResult =>
    reply(503, { error: 'Payments are switched off because the configured network is not Solana Devnet.', code: 'cluster_guard' });
  const unauthorized = (): RouteResult => reply(401, { error: 'Not signed in.', code: 'unauthorized' });
  const badBody = (message: string): RouteResult => reply(400, { error: message, code: 'bad_request' });

  function config(): RouteResult {
    const view: PaymentConfigView = payments ? payments.configView() : { enabled: false, cluster: 'devnet' };
    return { status: 200, body: view, headers: { 'Cache-Control': 'no-store' } };
  }

  async function challenge(ctx: RouteContext): Promise<RouteResult> {
    if (!payments || !wallet) return disabled();
    if (payments.clusterState === 'blocked') return blocked();
    const rl = limited(challengeLimiter, ctx.ip);
    if (rl) return rl;
    const parsed = WalletChallengeRequestSchema.safeParse({ publicKey: trim(obj(await ctx.readBody()).publicKey) });
    if (!parsed.success) return badBody('Send the wallet public key.');
    const r = wallet.createChallenge(parsed.data.publicKey);
    if (!r.ok) return reply(r.status, { error: r.error, code: r.code });
    return reply(200, { ...r.view });
  }

  async function verify(ctx: RouteContext): Promise<RouteResult> {
    if (!payments || !wallet) return disabled();
    if (payments.clusterState === 'blocked') return blocked();
    const rl = limited(verifyLimiter, ctx.ip);
    if (rl) return rl;
    // a bearer header means "link this wallet to my account"; none means "sign in with a wallet that is already linked"
    let account = null;
    if (ctx.authorization) {
      account = deps.accounts.authenticateHeader(ctx.authorization);
      if (!account) return unauthorized();
    }
    const body = obj(await ctx.readBody());
    const parsed = WalletVerifyRequestSchema.safeParse({ publicKey: trim(body.publicKey), signature: trim(body.signature), nonce: trim(body.nonce) ?? undefined });
    if (!parsed.success) return badBody('Send the wallet public key and the base58 signature.');
    const r = wallet.verify(parsed.data.publicKey, parsed.data.signature, parsed.data.nonce, account);
    if (!r.ok) return reply(r.status, { error: r.error, code: r.code });
    const view = deps.accounts.view(r.account);
    const out: WalletVerifyResponse = r.mode === 'signin' ? { mode: 'signin', account: view, token: r.token } : { mode: 'link', account: view };
    return reply(200, { ...out });
  }

  function unlink(ctx: RouteContext): RouteResult {
    if (!payments || !wallet) return disabled();
    const account = deps.accounts.authenticateHeader(ctx.authorization);
    if (!account) return unauthorized();
    wallet.unlink(account);
    return reply(200, { account: deps.accounts.view(account) });
  }

  async function intent(ctx: RouteContext): Promise<RouteResult> {
    if (!payments) return disabled();
    const account = deps.accounts.authenticateHeader(ctx.authorization);
    if (!account) return unauthorized();
    const rl = limited(intentLimiter, account.id);
    if (rl) return rl;
    const parsed = PayIntentRequestSchema.safeParse({ itemId: trim(obj(await ctx.readBody()).itemId) });
    if (!parsed.success) return badBody('Send the itemId you want to pay for.');
    const r = payments.createIntent(account, parsed.data.itemId);
    if (!r.ok) return reply(r.status, { error: r.error, code: r.code });
    return reply(200, { ...r.intent });
  }

  async function confirm(ctx: RouteContext): Promise<RouteResult> {
    if (!payments) return disabled();
    const account = deps.accounts.authenticateHeader(ctx.authorization);
    if (!account) return unauthorized();
    const rl = limited(confirmLimiter, account.id);
    if (rl) return rl;
    const body = obj(await ctx.readBody());
    const parsed = PayConfirmRequestSchema.safeParse({ intentId: trim(body.intentId), signature: trim(body.signature) });
    if (!parsed.success) return badBody('Send the intentId and the transaction signature.');
    const r = await payments.confirm(account, parsed.data.intentId, parsed.data.signature);
    if (!r.ok) {
      const extra: Record<string, unknown> = r.pending ? { pending: true } : {};
      return reply(r.status, { ok: false, error: r.error, code: r.code, ...extra });
    }
    // `message` is human text for the UI; the verified facts are `item` and `signature`
    return reply(200, { ok: true, item: r.item, signature: r.signature, message: `Payment verified on Solana Devnet. You received ${r.item.name}.` });
  }

  return {
    paths: PATHS,
    handles: (route) => ROUTES.has(route),
    async handle(route, ctx) {
      switch (route) {
        case 'GET /api/config':
          return config();
        case 'POST /api/wallet/challenge':
          return challenge(ctx);
        case 'POST /api/wallet/verify':
          return verify(ctx);
        case 'DELETE /api/wallet':
          return unlink(ctx);
        case 'POST /api/pay/intent':
          return intent(ctx);
        case 'POST /api/pay/confirm':
          return confirm(ctx);
        default:
          return reply(404, { error: 'Not found.' });
      }
    },
  };
}
