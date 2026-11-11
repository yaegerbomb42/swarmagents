import { describe, expect, it } from 'vitest';
import { KeyPool } from './keyPool';
import { ProviderRaceEngine } from './raceEngine';

interface FakeCall {
  url: string;
  init: RequestInit;
  aborted: boolean;
  respond: (opts?: RespondOpts) => void;
  fail: (error: unknown) => void;
}

interface RespondOpts {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function makeResponse({ status = 200, body = {}, headers = {} }: RespondOpts): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    json: async () => body,
  } as unknown as Response;
}

const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

function createFakeFetch() {
  const calls: FakeCall[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal;
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const call: FakeCall = {
        url: String(input),
        init,
        aborted: false,
        respond(opts) {
          signal?.removeEventListener('abort', onAbort);
          resolve(makeResponse(opts ?? {}));
        },
        fail(error) {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      const onAbort = () => {
        call.aborted = true;
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      calls.push(call);
    });
  }) as typeof fetch;

  return { fetchImpl, calls };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const validBody = (text: string, totalTokens = 10) => ({
  choices: [{ message: { content: text } }],
  usage: { total_tokens: totalTokens },
});

describe('ProviderRaceEngine', () => {
  it('resolves with the first valid response and aborts runner-ups', async () => {
    const { fetchImpl, calls } = createFakeFetch();
    const pool = new KeyPool({ provider: 'groq', keys: ['k1abcd', 'k2efgh'] });
    const engine = new ProviderRaceEngine({ pools: { groq: pool }, fetch: fetchImpl });

    const promise = engine.complete({ prompt: 'hello', provider: 'groq' });
    expect(calls).toHaveLength(2);

    calls[0]!.respond({ status: 200, body: validBody('first valid', 7) });

    await expect(promise).resolves.toMatchObject({
      text: 'first valid',
      provider: 'groq',
      keyIndex: 0,
      tokens: 7,
    });
    expect(calls[1]!.aborted).toBe(true);

    // Aborted runner-up is not penalized; winner is credited.
    const stats = pool.stats();
    expect(stats[0]).toMatchObject({ successes: 1, failures: 0 });
    expect(stats[1]).toMatchObject({ successes: 0, failures: 0 });
  });

  it('keeps waiting when a candidate returns an invalid/failed response', async () => {
    const { fetchImpl, calls } = createFakeFetch();
    const pool = new KeyPool({ provider: 'cerebras', keys: ['a1b2c3d4', 'e5f6g7h8'] });
    const engine = new ProviderRaceEngine({ pools: { cerebras: pool }, fetch: fetchImpl });

    const promise = engine.complete({ prompt: 'hi', provider: 'cerebras' });
    // First candidate returns an empty (invalid) body.
    calls[0]!.respond({ status: 200, body: validBody('') });
    await tick();
    expect(calls[1]!.aborted).toBe(false); // still racing

    calls[1]!.respond({ status: 200, body: validBody('good answer', 3) });
    await expect(promise).resolves.toMatchObject({ text: 'good answer', keyIndex: 1, tokens: 3 });

    const stats = pool.stats();
    expect(stats[0]).toMatchObject({ failures: 1 }); // invalid counts as status 0
    expect(stats[1]).toMatchObject({ successes: 1 });
  });

  it('rejects when every candidate fails', async () => {
    const { fetchImpl, calls } = createFakeFetch();
    const pool = new KeyPool({ provider: 'nemotron', keys: ['k1abcd', 'k2efgh'] });
    const engine = new ProviderRaceEngine({ pools: { nemotron: pool }, fetch: fetchImpl });

    const promise = engine.complete({ prompt: 'hi', provider: 'nemotron' });
    calls[0]!.respond({ status: 500, body: { error: { message: 'boom' } } });
    calls[1]!.respond({ status: 200, body: validBody('') }); // invalid text

    await expect(promise).rejects.toThrow(/failed/);
    const stats = pool.stats();
    expect(stats[0]).toMatchObject({ failures: 1 }); // HTTP 500
    expect(stats[1]).toMatchObject({ failures: 1 }); // invalid -> status 0
  });

  it('applies exponential backoff with a Retry-After floor on 429', async () => {
    let now = 0;
    const { fetchImpl, calls } = createFakeFetch();
    const pool = new KeyPool({
      provider: 'gemini',
      keys: ['k1abcd'],
      baseCooldownMs: 1000,
      maxCooldownMs: 300000,
      now: () => now,
    });
    const engine = new ProviderRaceEngine({ pools: { gemini: pool }, fetch: fetchImpl });

    // First failure: Retry-After 5s raises the 1s base backoff to 5s.
    const first = engine.complete({ prompt: 'hi', provider: 'gemini' });
    calls[0]!.respond({ status: 429, headers: { 'retry-after': '5' } });
    await expect(first).rejects.toThrow();

    let stats = pool.stats();
    expect(stats[0]).toMatchObject({ consecutiveFailures: 1, coolingUntil: 5000 });
    expect(pool.available()).toEqual([]);

    // After cooldown elapses, the key is usable again; the next 429 doubles.
    now = 5000;
    expect(pool.available()).toEqual([{ index: 0, key: 'k1abcd' }]);

    const second = engine.complete({ prompt: 'hi', provider: 'gemini' });
    calls[1]!.respond({ status: 429 });
    await expect(second).rejects.toThrow();

    stats = pool.stats();
    expect(stats[0]).toMatchObject({ consecutiveFailures: 2, coolingUntil: 7000 });
  });

  it('rejects when the caller aborts, without penalizing keys', async () => {
    const { fetchImpl, calls } = createFakeFetch();
    const pool = new KeyPool({ provider: 'groq', keys: ['k1abcd', 'k2efgh'] });
    const engine = new ProviderRaceEngine({ pools: { groq: pool }, fetch: fetchImpl });

    const controller = new AbortController();
    const promise = engine.complete({ prompt: 'hi', provider: 'groq', signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toThrow();
    expect(calls.every((c) => c.aborted)).toBe(true);
    const stats = pool.stats();
    expect(stats.every((s) => s.failures === 0)).toBe(true);
  });

  it('races at most `candidates` keys', async () => {
    const { fetchImpl, calls } = createFakeFetch();
    const pool = new KeyPool({ provider: 'mercury', keys: ['k1abcd', 'k2efgh', 'k3ijkl'] });
    const engine = new ProviderRaceEngine({ pools: { mercury: pool }, fetch: fetchImpl });

    const promise = engine.complete({ prompt: 'hi', provider: 'mercury', candidates: 2 });
    expect(calls).toHaveLength(2);

    calls[0]!.respond({ status: 200, body: validBody('ok') });
    await expect(promise).resolves.toMatchObject({ keyIndex: 0, text: 'ok' });
    expect(calls[1]!.aborted).toBe(true);
    expect(calls.length).toBe(2);
  });
});

describe('KeyPool', () => {
  it('serves keys round-robin starting after the last used key', () => {
    const pool = new KeyPool({ provider: 'gemini', keys: ['aaaa1111', 'bbbb2222', 'cccc3333'] });

    expect(pool.take(1)).toEqual([{ index: 0, key: 'aaaa1111' }]);
    expect(pool.take(1)).toEqual([{ index: 1, key: 'bbbb2222' }]);
    expect(pool.take(2)).toEqual([
      { index: 2, key: 'cccc3333' },
      { index: 0, key: 'aaaa1111' },
    ]);
    expect(pool.take(10)).toEqual([
      { index: 1, key: 'bbbb2222' },
      { index: 2, key: 'cccc3333' },
      { index: 0, key: 'aaaa1111' },
    ]);
  });

  it('maintains exponential moving averages for latency and tokens/sec', () => {
    const pool = new KeyPool({ provider: 'mercury', keys: ['m1mercury'] });
    pool.reportSuccess(0, { latencyMs: 100, tokens: 100 }); // 1000 tok/s
    pool.reportSuccess(0, { latencyMs: 200, tokens: 60 }); // 300 tok/s

    const stats = pool.stats()[0]!;
    expect(stats.avgLatencyMs).toBeCloseTo(100 * 0.7 + 200 * 0.3, 5); // 130
    expect(stats.tokensPerSec).toBeCloseTo(1000 * 0.7 + 300 * 0.3, 5); // 790
    expect(stats.suffix).toBe('cury');
    expect(stats.successes).toBe(2);
    expect(stats.failures).toBe(0);
  });

  it('reports stats per key with only the last 4 chars of the key', () => {
    const pool = new KeyPool({ provider: 'groq', keys: ['sk-very-secret-key-abc1'] });
    expect(pool.stats()[0]).toMatchObject({ suffix: 'abc1' });
  });
});
