import { describe, expect, it } from 'vitest';
import { ProviderError } from '../errors.js';
import type { CompletionRequest, CompletionResponse, Provider } from '../providers/types.js';
import { ClusterRouter, KeyCluster, isUsableResponse, looksGarbled } from './key-cluster.js';
import { buildClusters, keysFromEnv } from './clusters.js';

const usage = { uncached: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1 };
const reply = (text: string, model = 'm'): CompletionResponse => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  usage,
  model,
});
const req = (over: Partial<CompletionRequest> = {}): CompletionRequest => ({
  model: 'm',
  system: [],
  tools: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  maxTokens: 10,
  messageBreakpoints: [],
  ...over,
});

type Behaviour = { delay: number; result: string | { status: number; retryAfterMs?: number } };

function fake(behaviours: Behaviour[], log: { aborted: number[]; calls: number[] }) {
  return (_key: string, i: number): Provider => ({
    name: 'fake',
    complete: (r) =>
      new Promise((resolve, reject) => {
        log.calls.push(i);
        const b = behaviours[i] ?? { delay: 1, result: 'ok' };
        const t = setTimeout(() => {
          if (typeof b.result === 'string') resolve(reply(b.result, `key${String(i)}`));
          else
            reject(
              new ProviderError(`HTTP ${String(b.result.status)}`, {
                retryable: b.result.status === 429 || b.result.status >= 500,
                status: b.result.status,
                ...(b.result.retryAfterMs ? { retryAfterMs: b.result.retryAfterMs } : {}),
              }),
            );
        }, b.delay);
        r.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          log.aborted.push(i);
          reject(new Error('aborted'));
        });
      }),
  });
}

const cluster = (behaviours: Behaviour[], log = { aborted: [] as number[], calls: [] as number[] }, extra = {}) =>
  new KeyCluster({
    name: 'c',
    baseUrl: 'http://x',
    model: 'm',
    keys: behaviours.map((_, i) => `key-${String(i)}-abcd`),
    makeClient: fake(behaviours, log),
    ...extra,
  });

describe('KeyCluster', () => {
  it('races keys and returns the fastest answer, aborting the loser', async () => {
    const log = { aborted: [] as number[], calls: [] as number[] };
    const c = cluster([{ delay: 50, result: 'slow' }, { delay: 5, result: 'fast' }], log, { raceWidth: 2 });
    const res = await c.complete(req());
    expect(res.model).toBe('key1');
    expect(log.calls.sort()).toEqual([0, 1]);
    expect(log.aborted).toEqual([0]);
  });

  it('benches a 401/403 key and fails over to the next wave', async () => {
    const c = cluster([{ delay: 1, result: { status: 401 } }, { delay: 1, result: 'ok' }], undefined, { raceWidth: 1 });
    const res = await c.complete(req());
    expect(res.model).toBe('key1');
    expect(c.stats()[0]?.state).toBe('cooling');
    // The dead key is never tried again.
    const log2 = await c.complete(req());
    expect(log2.model).toBe('key1');
  });

  it('cools down a 429 key for Retry-After and rotates', async () => {
    let now = 1_000;
    const c = cluster(
      [{ delay: 1, result: { status: 429, retryAfterMs: 60_000 } }, { delay: 1, result: 'ok' }],
      undefined,
      { raceWidth: 1, now: () => now },
    );
    await c.complete(req());
    expect(c.stats()[0]?.state).toBe('cooling');
    now += 61_000;
    expect(c.stats()[0]?.state).toBe('ok');
  });

  it('does not let a garbled answer win', async () => {
    const c = cluster([{ delay: 1, result: '-Re-Re-P-P-P\uFFFD' }, { delay: 20, result: 'Four' }], undefined, { raceWidth: 2 });
    const res = await c.complete(req());
    expect(res.model).toBe('key1');
  });

  it('throws the rate limit when every key is throttled', async () => {
    const c = cluster([{ delay: 1, result: { status: 429 } }, { delay: 1, result: { status: 429 } }], undefined, { raceWidth: 2 });
    await expect(c.complete(req())).rejects.toMatchObject({ status: 429 });
  });

  it('does not retry a malformed request across the pool', async () => {
    const log = { aborted: [] as number[], calls: [] as number[] };
    const c = cluster([{ delay: 1, result: { status: 400 } }, { delay: 1, result: 'ok' }], log, { raceWidth: 1 });
    await expect(c.complete(req())).rejects.toMatchObject({ status: 400 });
    expect(log.calls).toEqual([0]);
  });

  it('never exposes full keys in stats', () => {
    const c = cluster([{ delay: 1, result: 'ok' }]);
    expect(JSON.stringify(c.stats())).not.toContain('key-0-abcd');
    expect(c.stats()[0]?.suffix).toBe('abcd');
  });
});

describe('ClusterRouter', () => {
  it('fails over to another cluster when the primary is exhausted', async () => {
    const a = new KeyCluster({ name: 'a', baseUrl: 'x', model: 'ma', keys: ['k1'], makeClient: fake([{ delay: 1, result: { status: 429 } }], { aborted: [], calls: [] }) });
    const b = new KeyCluster({ name: 'b', baseUrl: 'x', model: 'mb', keys: ['k2'], makeClient: fake([{ delay: 1, result: 'from b' }], { aborted: [], calls: [] }) });
    const r = new ClusterRouter([a, b]);
    const res = await r.complete(req({ route: 'a' }));
    expect(res.content[0]).toMatchObject({ text: 'from b' });
  });

  it('races clusters with their own model ids', async () => {
    const seen: string[] = [];
    const mk = (name: string, delay: number): KeyCluster =>
      new KeyCluster({
        name,
        baseUrl: 'x',
        model: `${name}-model`,
        keys: ['k'],
        makeClient: () => ({
          name,
          complete: (r) =>
            new Promise((res) => {
              seen.push(r.model);
              setTimeout(() => res(reply(name, r.model)), delay);
            }),
        }),
      });
    const r = new ClusterRouter([mk('slow', 40), mk('fast', 2)], { race: true });
    const res = await r.complete(req());
    expect(res.model).toBe('fast-model');
    expect(seen.sort()).toEqual(['fast-model', 'slow-model']);
  });
});

describe('env + validation helpers', () => {
  it('collects keys from list, single and numbered vars without duplicates', () => {
    const env = { NVIDIA_API_KEYS: 'a, b', NVIDIA_API_KEY: 'b', NVIDIA_API_KEY_2: 'd', NVIDIA_API_KEY_1: 'c' };
    expect(keysFromEnv(env, 'NVIDIA')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('builds only clusters that have keys', () => {
    const cs = buildClusters({ INCEPTION_API_KEYS: 'k1,k2' });
    expect(cs.map((c) => [c.name, c.size, c.model])).toEqual([['mercury', 2, 'mercury-3']]);
  });

  it('flags garbled text and accepts tool calls', () => {
    expect(looksGarbled('-Re-Re-P-Re')).toBe(true);
    expect(looksGarbled('The answer is four.')).toBe(false);
    expect(isUsableResponse({ ...reply(''), content: [{ type: 'tool_use', id: '1', name: 'read', input: {} }] })).toBe(true);
    expect(isUsableResponse(reply(''))).toBe(false);
  });
});
