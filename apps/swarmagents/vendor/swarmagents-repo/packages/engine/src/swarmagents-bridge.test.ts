import { describe, expect, it } from 'vitest';
import { OmnexxSwarmBridge, type SwarmTelemetryEvent } from './swarmagents-bridge.js';

/** An OpenAI-compatible endpoint that writes one file, then answers. */
function scriptedFetch(): { fetch: typeof fetch; calls: () => number } {
  let n = 0;
  const reply = (message: Record<string, unknown>, finish: string) =>
    new Response(
      JSON.stringify({
        model: 'mercury-3',
        choices: [{ finish_reason: finish, message }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const f = (async () => {
    n++;
    if (n === 1)
      return reply(
        {
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'write_file', arguments: JSON.stringify({ path: 'hello.txt', content: 'hi there\n' }) },
            },
          ],
        },
        'tool_calls',
      );
    return reply({ content: 'Wrote hello.txt.' }, 'stop');
  }) as unknown as typeof fetch;
  return { fetch: f, calls: () => n };
}

describe('OmnexxSwarmBridge', () => {
  it('runs the agent loop on a key cluster and streams step telemetry', async () => {
    const { fetch, calls } = scriptedFetch();
    const events: SwarmTelemetryEvent[] = [];
    const res = await new OmnexxSwarmBridge().executeTask(
      { id: 't1', title: 'say hi', description: 'Write hello.txt', provider: 'mercury' },
      { env: { INCEPTION_API_KEYS: 'test-key-aaaa' }, fetch, onEvent: (e) => events.push(e) },
    );
    expect(res.status).toBe('completed');
    expect(res.files).toEqual([{ path: 'hello.txt', content: 'hi there\n', bytes: 9 }]);
    expect(res.finalText).toContain('hello.txt');
    expect(calls()).toBe(2);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('task.started');
    expect(types).toContain('step.model');
    expect(types).toContain('step.tool.start');
    expect(types).toContain('step.tool.done');
    expect(types.at(-1)).toBe('task.done');
    // Sequence numbers are strictly increasing and keys never appear in telemetry.
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(JSON.stringify(events)).not.toContain('test-key-aaaa');
  });

  it('fails cleanly when no keys are configured', async () => {
    const res = await new OmnexxSwarmBridge().executeTask(
      { id: 't2', title: 'x', description: 'y' },
      { env: {} },
    );
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/NVIDIA_API_KEYS/);
  });
});
