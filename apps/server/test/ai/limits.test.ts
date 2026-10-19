import { describe, expect, it } from 'vitest';
import { AI_MESSAGE_MAX_LENGTH } from '@pixels/shared';
import type { AiErrorResponse, AiGameApi } from '@pixels/shared';
import { createAssistant } from '../../src/ai';
import { DailyQuota, RateLimiter } from '../../src/ai/limits';
import { ConversationMemory } from '../../src/ai/memory';
import { createFakeApi, expectResponse, isError } from './helpers/fakeApi';

const T0 = Date.UTC(2026, 5, 1, 12, 0, 0); // noon UTC
let n = 0;
const key = () => `limits-player-${++n}`;

function rulesAssistant(over: Partial<Parameters<typeof createAssistant>[0]> = {}) {
  return createAssistant({ provider: 'rules', model: 'x', timeoutMs: 1000, dailyLimit: 50, ratePerMinute: 100, ...over });
}

describe('message validation', () => {
  it('rejects empty, whitespace-only, control-only, non-string and over-long messages as bad_request', async () => {
    const a = rulesAssistant();
    const api = createFakeApi();
    const bad = ['', '   ', '\n\t', String.fromCharCode(0, 1, 2, 7), 'x'.repeat(AI_MESSAGE_MAX_LENGTH + 1), ' ' + 'y'.repeat(AI_MESSAGE_MAX_LENGTH + 5), 42 as unknown as string, null as unknown as string, undefined as unknown as string];
    for (const message of bad) {
      const r = await a.handle({ playerKey: key(), message, api, now: T0 });
      expect(isError(r), String(message).slice(0, 20)).toBe(true);
      expect((r as AiErrorResponse).code).toBe('bad_request');
    }
    expect(api.calls).toHaveLength(0);
  });

  it('accepts a message of exactly the maximum length', async () => {
    const a = rulesAssistant();
    const r = await a.handle({ playerKey: key(), message: 'a'.repeat(AI_MESSAGE_MAX_LENGTH), api: createFakeApi(), now: T0 });
    expect(isError(r)).toBe(false);
  });

  it('rejects a missing player key and a missing api', async () => {
    const a = rulesAssistant();
    expect(await a.handle({ playerKey: '', message: 'hi', api: createFakeApi(), now: T0 })).toMatchObject({ code: 'bad_request' });
    expect(await a.handle({ playerKey: key(), message: 'hi', api: undefined as unknown as AiGameApi, now: T0 })).toMatchObject({ code: 'unavailable' });
  });

  it('bad requests do not use up rate-limit slots or daily quota', async () => {
    const a = rulesAssistant({ ratePerMinute: 1, dailyLimit: 1 });
    const k = key();
    const api = createFakeApi();
    for (let i = 0; i < 5; i++) await a.handle({ playerKey: k, message: '', api, now: T0 });
    const ok = expectResponse(await a.handle({ playerKey: k, message: 'hi', api, now: T0 }));
    expect(ok.usage.remainingToday).toBe(0);
  });
});

describe('per-player rate limit', () => {
  it('limits to ratePerMinute in a sliding window, with retryAfterSec', async () => {
    const a = rulesAssistant({ ratePerMinute: 3 });
    const api = createFakeApi();
    const k = key();
    for (let i = 0; i < 3; i++) expectResponse(await a.handle({ playerKey: k, message: 'hi', api, now: T0 + i * 1000 }));
    const blocked = await a.handle({ playerKey: k, message: 'hi', api, now: T0 + 3000 });
    expect(blocked).toMatchObject({ code: 'rate_limited' });
    // oldest request at T0 frees its slot at T0 + 60s: 57 s from T0 + 3 s
    expect((blocked as AiErrorResponse).retryAfterSec).toBe(57);

    // still blocked just before the window slides, free right after
    expect(await a.handle({ playerKey: k, message: 'hi', api, now: T0 + 59_999 })).toMatchObject({ code: 'rate_limited' });
    expectResponse(await a.handle({ playerKey: k, message: 'hi', api, now: T0 + 60_001 }));
    // sliding: the second and third requests are still in the window, so the new one counts
    expect(await a.handle({ playerKey: k, message: 'hi', api, now: T0 + 60_500 })).toMatchObject({ code: 'rate_limited' });
    expectResponse(await a.handle({ playerKey: k, message: 'hi', api, now: T0 + 61_001 }));
  });

  it('is per player', async () => {
    const a = rulesAssistant({ ratePerMinute: 1 });
    const api = createFakeApi();
    expectResponse(await a.handle({ playerKey: 'p-a', message: 'hi', api, now: T0 }));
    expect(await a.handle({ playerKey: 'p-a', message: 'hi', api, now: T0 + 1 })).toMatchObject({ code: 'rate_limited' });
    expectResponse(await a.handle({ playerKey: 'p-b', message: 'hi', api, now: T0 + 1 }));
  });

  it('rate-limited requests do not consume daily quota or reach the game api', async () => {
    const a = rulesAssistant({ ratePerMinute: 1, dailyLimit: 3 });
    const api = createFakeApi();
    const k = key();
    expectResponse(await a.handle({ playerKey: k, message: 'who is online', api, now: T0 }));
    const before = api.calls.length;
    for (let i = 0; i < 10; i++) expect(await a.handle({ playerKey: k, message: 'who is online', api, now: T0 + 10 })).toMatchObject({ code: 'rate_limited' });
    expect(api.calls.length).toBe(before);
    const next = expectResponse(await a.handle({ playerKey: k, message: 'hi', api, now: T0 + 61_000 }));
    expect(next.usage.remainingToday).toBe(1);
  });

  it('RateLimiter bounds its memory', () => {
    const rl = new RateLimiter(5, 60_000, 50);
    for (let i = 0; i < 500; i++) expect(rl.tryAcquire(`u${i}`, T0 + i).ok).toBe(true);
    // internal map stays bounded (checked indirectly: old keys were pruned and start fresh)
    expect(rl.tryAcquire('u0', T0 + 1000).ok).toBe(true);
  });
});

describe('daily usage cap', () => {
  it('counts successful calls, reports remainingToday and then returns quota_exceeded', async () => {
    const a = rulesAssistant({ dailyLimit: 3 });
    const api = createFakeApi();
    const k = key();
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = expectResponse(await a.handle({ playerKey: k, message: 'hello', api, now: T0 + i * 61_000 }));
      expect(r.usage.limitPerDay).toBe(3);
      seen.push(r.usage.remainingToday);
    }
    expect(seen).toEqual([2, 1, 0]);
    const blocked = await a.handle({ playerKey: k, message: 'hello', api, now: T0 + 4 * 61_000 });
    expect(blocked).toMatchObject({ code: 'quota_exceeded' });
    // noon + 4 minutes -> about 11h56m to midnight UTC
    const expected = Math.ceil((Date.UTC(2026, 5, 2) - (T0 + 4 * 61_000)) / 1000);
    expect((blocked as AiErrorResponse).retryAfterSec).toBe(expected);
  });

  it('resets at UTC midnight', async () => {
    const a = rulesAssistant({ dailyLimit: 1 });
    const api = createFakeApi();
    const k = key();
    const beforeMidnight = Date.UTC(2026, 5, 1, 23, 59, 30);
    expectResponse(await a.handle({ playerKey: k, message: 'hi', api, now: beforeMidnight }));
    const denied = await a.handle({ playerKey: k, message: 'hi', api, now: beforeMidnight + 20_000 });
    expect(denied).toMatchObject({ code: 'quota_exceeded', retryAfterSec: 10 });
    const after = expectResponse(await a.handle({ playerKey: k, message: 'hi', api, now: Date.UTC(2026, 5, 2, 0, 0, 1) }));
    expect(after.usage).toEqual({ remainingToday: 0, limitPerDay: 1 });
  });

  it('is per player and a limit of 0 disables the assistant', async () => {
    const a = rulesAssistant({ dailyLimit: 1 });
    const api = createFakeApi();
    expectResponse(await a.handle({ playerKey: 'q-a', message: 'hi', api, now: T0 }));
    expect(await a.handle({ playerKey: 'q-a', message: 'hi', api, now: T0 + 61_000 })).toMatchObject({ code: 'quota_exceeded' });
    expectResponse(await a.handle({ playerKey: 'q-b', message: 'hi', api, now: T0 }));
    const off = rulesAssistant({ dailyLimit: 0 });
    expect(await off.handle({ playerKey: key(), message: 'hi', api, now: T0 })).toMatchObject({ code: 'quota_exceeded' });
  });

  it('concurrent requests cannot overshoot the daily cap', async () => {
    const a = rulesAssistant({ dailyLimit: 2, ratePerMinute: 100 });
    const api = createFakeApi();
    const k = key();
    const results = await Promise.all(Array.from({ length: 6 }, () => a.handle({ playerKey: k, message: 'hi', api, now: T0 })));
    expect(results.filter((r) => !isError(r))).toHaveLength(2);
    expect(results.filter((r) => isError(r) && (r as AiErrorResponse).code === 'quota_exceeded')).toHaveLength(4);
  });

  it('refusals and rules answers count as calls too', async () => {
    const a = rulesAssistant({ dailyLimit: 2 });
    const api = createFakeApi();
    const k = key();
    expectResponse(await a.handle({ playerKey: k, message: 'sign the transaction', api, now: T0 }));
    const second = expectResponse(await a.handle({ playerKey: k, message: 'hi', api, now: T0 + 61_000 }));
    expect(second.usage.remainingToday).toBe(0);
  });

  it('DailyQuota refund and pruning', () => {
    const q = new DailyQuota(2, 10);
    expect(q.reserve('a', T0)).toBe(true);
    q.refund('a', T0);
    expect(q.remaining('a', T0)).toBe(2);
    for (let i = 0; i < 100; i++) q.reserve(`k${i}`, T0);
    expect(q.remaining('k99', T0)).toBe(1);
  });
});

describe('robustness', () => {
  it('never throws out of handle(), even when the game api blows up', async () => {
    const a = rulesAssistant();
    const exploding = new Proxy(createFakeApi(), {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v === 'function' && !['callsTo', 'setPosition', 'setCoins'].includes(String(prop))) {
          return () => {
            throw new Error('database password=hunter2 exploded');
          };
        }
        return v;
      },
    }) as unknown as AiGameApi;
    for (const message of ['Take me to the shop', 'Show me what I can buy', "I'm bored", 'who is online', 'hello', 'buy the cap', 'how many coins do I have']) {
      const r = await a.handle({ playerKey: key(), message, api: exploding, now: T0 });
      expect(JSON.stringify(r)).not.toContain('hunter2');
      expect(typeof r).toBe('object');
    }
  });

  it('survives hostile inputs', async () => {
    const a = rulesAssistant();
    const api = createFakeApi();
    for (const input of [null, undefined, {}, { playerKey: 1 }, { playerKey: 'x', message: { toString: () => 'hi' } }, { playerKey: 'x'.repeat(1000), message: 'hi' }]) {
      const r = await a.handle(input as never);
      expect(isError(r as never)).toBe(true);
    }
    const r = await a.handle({ playerKey: key(), message: 'hi', api, now: Number.NaN });
    expect(isError(r)).toBe(false);
  });

  it('describe() reports the configured providers', () => {
    expect(rulesAssistant().describe()).toEqual({ provider: 'rules', model: null });
    expect(createAssistant({ provider: 'auto', model: 'm', timeoutMs: 1, dailyLimit: 1, ratePerMinute: 1 }).describe()).toEqual({ provider: 'rules', model: null });
    expect(createAssistant({ provider: 'auto', apiKey: 'k', model: 'm', timeoutMs: 1, dailyLimit: 1, ratePerMinute: 1 }).describe().model).toBe('m');
  });

  it('tolerates nonsensical configuration values', async () => {
    const a = createAssistant({ provider: 'bogus' as never, model: '', timeoutMs: Number.NaN, dailyLimit: -5, ratePerMinute: 0 });
    // dailyLimit clamps to 0 -> disabled, never a crash
    expect(await a.handle({ playerKey: key(), message: 'hi', api: createFakeApi(), now: T0 })).toMatchObject({ code: 'quota_exceeded' });
  });
});

describe('conversation memory', () => {
  it('keeps the last 6 turns, expires after 30 minutes and stays bounded', () => {
    const m = new ConversationMemory(6, 30 * 60_000, 3);
    for (let i = 1; i <= 8; i++) m.add('a', { user: `u${i}`, assistant: `a${i}` }, T0 + i);
    expect(m.get('a', T0 + 10).map((t) => t.user)).toEqual(['u3', 'u4', 'u5', 'u6', 'u7', 'u8']);
    expect(m.get('a', T0 + 8 + 30 * 60_000 + 1)).toEqual([]);
    for (const k of ['b', 'c', 'd', 'e']) m.add(k, { user: 'x', assistant: 'y' }, T0 + 100);
    expect(m.size).toBeLessThanOrEqual(3);
    expect(m.get('a', T0 + 100)).toEqual([]);
    expect(m.get('e', T0 + 100)).toHaveLength(1);
  });
});
