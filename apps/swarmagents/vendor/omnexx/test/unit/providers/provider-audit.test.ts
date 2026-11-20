import { describe, expect, it } from 'vitest';
import { computePrefixHash } from '../../../src/agent/context.js';
import { AnthropicProvider } from '../../../src/providers/anthropic.js';
import {
  cacheKeyFor,
  pinPrefix,
  prefixHash,
  stableJsonStringify,
} from '../../../src/providers/cache-pinning.js';
import {
  ANTHROPIC_MAX_BREAKPOINTS,
  injectPromptCaching,
  type CacheableMessage,
} from '../../../src/providers/cache-headers.js';
import { toChatMessages } from '../../../src/providers/openai-compat.js';
import { CacheMeter } from '../../../src/telemetry/cache-meter.js';
import type { CompletionRequest, SystemBlock, ToolSpec } from '../../../src/providers/types.js';

describe('Subsystem 3 Audit: Provider Wire Protocols, Dual-Breakpoints & KV-Cache Pinning', () => {
  describe('1. Prefix Cache Stability (Level 0 & Level 1)', () => {
    const baseTools: ToolSpec[] = [
      {
        name: 'edit',
        description: 'Edit a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      {
        name: 'bash',
        description: 'Run a shell command',
        inputSchema: {
          type: 'object',
          properties: { command: { type: 'string' }, timeout: { type: 'number' } },
          required: ['command'],
        },
      },
    ];

    const baseSystem: SystemBlock[] = [
      { text: 'Core identity: Lead Orchestrator', volatile: false },
      { text: 'Repository map and structural overview', volatile: false },
      { text: 'Clock: 2026-11-08T18:00:00Z (Turn 1)', volatile: true },
    ];

    it('volatile clock ticks do NOT mutate the prefix hash', () => {
      const hash1 = prefixHash({ system: baseSystem, tools: baseTools });

      const advancedClockSystem: SystemBlock[] = [
        { text: 'Core identity: Lead Orchestrator', volatile: false },
        { text: 'Repository map and structural overview', volatile: false },
        { text: 'Clock: 2026-11-08T18:05:42Z (Turn 2, 5m later)', volatile: true },
      ];

      const hash2 = prefixHash({ system: advancedClockSystem, tools: baseTools });
      expect(hash1).toBe(hash2);
    });

    it('computePrefixHash in context.ts is unaffected by volatile block changes', () => {
      const hash1 = computePrefixHash(baseTools, baseSystem, 'anchor-plan-v1');

      const mutatedClockSystem: SystemBlock[] = [
        { text: 'Core identity: Lead Orchestrator', volatile: false },
        { text: 'Repository map and structural overview', volatile: false },
        { text: 'Clock: 2026-11-08T18:10:00Z (Turn 3)', volatile: true },
      ];

      const hash2 = computePrefixHash(baseTools, mutatedClockSystem, 'anchor-plan-v1');
      expect(hash1).toBe(hash2);
    });

    it('tool inputSchema key order differences yield identical prefix hashes', () => {
      const toolsOrderA: ToolSpec[] = [
        {
          name: 'tool_test',
          description: 'test',
          inputSchema: { b: 2, a: 1, nested: { z: 9, y: 8 } },
        },
      ];

      const toolsOrderB: ToolSpec[] = [
        {
          name: 'tool_test',
          description: 'test',
          inputSchema: { a: 1, b: 2, nested: { y: 8, z: 9 } },
        },
      ];

      const hashA = prefixHash({ system: baseSystem, tools: toolsOrderA });
      const hashB = prefixHash({ system: baseSystem, tools: toolsOrderB });
      expect(hashA).toBe(hashB);
    });

    it('pinPrefix positions all stable blocks before volatile blocks and sets cacheBreakpoint on last stable', () => {
      const mixed: SystemBlock[] = [
        { text: 'volatile 1', volatile: true },
        { text: 'stable 1', volatile: false },
        { text: 'volatile 2', volatile: true },
        { text: 'stable 2', volatile: false },
      ];

      const pinned = pinPrefix(mixed);
      expect(pinned.length).toBe(4);
      expect(pinned[0]?.text).toBe('stable 1');
      expect(pinned[0]?.volatile).toBe(false);
      expect(pinned[1]?.text).toBe('stable 2');
      expect(pinned[1]?.cacheBreakpoint).toBe(true);
      expect(pinned[2]?.text).toBe('volatile 1');
      expect(pinned[2]?.volatile).toBe(true);
      expect(pinned[3]?.text).toBe('volatile 2');
      expect(pinned[3]?.volatile).toBe(true);
    });

    it('cacheKeyFor produces a stable shard key for the session across turns', () => {
      const key1 = cacheKeyFor('run-1234', 'abcdef0123456789extra');
      const key2 = cacheKeyFor('run-1234', 'abcdef0123456789diff');
      expect(key1).toBe('omnexx-run-1234-abcdef0123456789');
      expect(key2).toBe('omnexx-run-1234-abcdef0123456789');
    });
  });

  describe('2. Anthropic Max-4 Breakpoint Budget Compliance', () => {
    it('AnthropicProvider.buildParams strictly adheres to max 4 cache_control breakpoints', () => {
      const provider = new AnthropicProvider({
        apiKey: 'sk-ant-test-key-12345',
        cacheTtl: '5m',
        timeoutMs: 10_000,
      });

      const req: CompletionRequest = {
        model: 'claude-3-7-sonnet-20250219',
        maxTokens: 4096,
        system: [
          { text: 'Stable system instruction 1', volatile: false },
          { text: 'Stable system instruction 2', volatile: false },
          { text: 'Volatile turn clock', volatile: true },
        ],
        tools: [
          { name: 't1', description: 'tool 1', inputSchema: {} },
          { name: 't2', description: 'tool 2', inputSchema: {} },
        ],
        // Request 10 message breakpoints
        messageBreakpoints: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        messages: Array.from({ length: 10 }, (_, i) => ({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: [{ type: 'text', text: `Message content turn ${i}` }],
        })),
      };

      const params = provider.buildParams(req);

      // Count breakpoints
      let count = 0;
      for (const t of params.tools ?? []) {
        if ('cache_control' in t && t.cache_control) count++;
      }
      if (Array.isArray(params.system)) {
        for (const s of params.system) {
          if ('cache_control' in s && s.cache_control) count++;
        }
      }
      for (const m of params.messages) {
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if ('cache_control' in b && b.cache_control) count++;
          }
        }
      }

      expect(count).toBeLessThanOrEqual(ANTHROPIC_MAX_BREAKPOINTS);
      expect(count).toBe(4);
    });

    it('injectPromptCaching caps injected breakpoints at 4 across long message sequences', () => {
      const messages: CacheableMessage[] = [
        { role: 'system', content: 'System block 1' },
        { role: 'system', content: 'System block 2' },
        ...Array.from({ length: 15 }, (_, i) => ({
          role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
          content: `Turn line ${i}`,
        })),
      ];

      const injected = injectPromptCaching(messages, 'anthropic');
      let annotated = 0;
      for (const m of injected) {
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            const blockWithCache = b as { cache_control?: unknown };
            if (blockWithCache.cache_control) annotated++;
          }
        }
      }

      expect(annotated).toBeLessThanOrEqual(4);
    });
  });

  describe('3. OpenAI / DeepSeek Deterministic JSON Key Ordering', () => {
    it('stableJsonStringify deeply sorts object keys alphabetically', () => {
      const unsorted = {
        zeta: 'last',
        alpha: 1,
        nested: {
          zebra: 100,
          apple: 200,
          list: [{ y: 2, x: 1 }],
        },
      };

      const serialized = stableJsonStringify(unsorted);
      expect(serialized).toBe(
        '{"alpha":1,"nested":{"apple":200,"list":[{"x":1,"y":2}],"zebra":100},"zeta":"last"}',
      );
    });

    it('toChatMessages formats assistant tool calls with deterministic sorted JSON arguments', () => {
      const req: CompletionRequest = {
        model: 'gpt-4o',
        maxTokens: 4096,
        messageBreakpoints: [],
        system: [{ text: 'System instruction', volatile: false }],
        tools: [],
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_123',
                name: 'edit_file',
                input: { path: 'src/app.ts', content: 'export const x = 1;', mode: 'write' },
              },
            ],
          },
        ],
      };

      const chatMessages = toChatMessages(req);
      const assistantMsg = chatMessages.find((m) => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg?.tool_calls?.[0]?.function.name).toBe('edit_file');

      const rawArgs = assistantMsg?.tool_calls?.[0]?.function.arguments ?? '';
      // Keys must be alphabetical: content, mode, path
      expect(rawArgs).toBe('{"content":"export const x = 1;","mode":"write","path":"src/app.ts"}');
    });
  });

  describe('4. CacheMeter Telemetry & Token Parsing', () => {
    it('computes accurate hit ratio and dollar savings across turns', () => {
      const meter = new CacheMeter();

      meter.recordTurn(CacheMeter.fromAnthropic(10_000, 8_000));
      meter.recordTurn(CacheMeter.fromOpenAI(10_000, 8_500));
      meter.recordTurn(CacheMeter.fromDeepSeek(10_000, 7_500, 7_500));

      expect(meter.turns).toBe(3);
      expect(meter.promptTotal).toBe(30_000);
      expect(meter.cachedTotal).toBe(24_000);

      const ratio = meter.getTurnRatio();
      expect(ratio).toBeCloseTo(0.8, 2);

      const stats = meter.getSessionStats();
      expect(stats.overallHitRatio).toBeCloseTo(0.8, 2);
      expect(stats.estimatedDollarSavings).toBeGreaterThan(0);
    });

    it('returns zero ratio safely when promptTotal is 0', () => {
      const meter = new CacheMeter();
      expect(meter.getTurnRatio()).toBe(0);
      expect(meter.getSessionStats().overallHitRatio).toBe(0);
    });
  });
});
