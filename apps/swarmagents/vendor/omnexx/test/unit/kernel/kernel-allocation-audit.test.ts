import { describe, expect, it } from 'vitest';
import { CapabilityCatalog, syntheticCatalog } from '../../../src/runtime/kernel/catalog.js';
import { heuristicAllocate } from '../../../src/runtime/kernel/ollamaRouter.js';
import {
  DEFAULT_ESSENTIAL_TOOLS,
  type AdaptiveRuntimeKernel,
} from '../../../src/runtime/kernel/kernel.js';
import type { TurnAllocation } from '../../../src/runtime/kernel/types.js';
import { fakeTool, offlineKernel } from '../runtime/kernel-test-helpers.js';

const recoveryTools = [
  'read',
  'bash',
  'execute_command',
  'str_replace',
  'write_file',
  'multi_edit',
  'apply_patch',
  'edit',
];

/** Force the meta-router to return a fixed allocation (simulates a tier-3 decision). */
function forceAllocation(k: AdaptiveRuntimeKernel, alloc: TurnAllocation): void {
  (k as unknown as { router: { allocate: () => Promise<TurnAllocation> } }).router.allocate = () =>
    Promise.resolve(alloc);
}

function tier3(mountedTools: string[]): TurnAllocation {
  return {
    tier: 3,
    reasoningMode: 'cot',
    activeRoles: ['planner', 'executor', 'verifier'],
    mountedTools,
    mountedSkills: [],
    maxTokensTurn: 400,
    allowCodeModeBatching: false,
    blastRadius: 'medium',
  };
}

describe('S6 audit: budget cap enforcement preserves core primitives', () => {
  it('exposes the recovery primitives in the essential set (read, write_file, str_replace, shell)', () => {
    for (const name of ['read', 'write_file', 'str_replace', 'bash', 'execute_command']) {
      expect(DEFAULT_ESSENTIAL_TOOLS, name).toContain(name);
    }
  });

  it('keeps read/write_file/str_replace/bash and editing tools under a tier-3 squeeze', async () => {
    const k = offlineKernel();
    const tools = [...recoveryTools, 'search', 'mcp__acme__edit', 'deploy'].map((n) => fakeTool(n));
    forceAllocation(k, tier3(['read', 'search']));
    const plan = await k.planTurn({
      objective: 'fix this',
      allTools: tools,
      defaultMaxTokens: 1000,
    });
    const names = new Set(plan.tools.map((t) => t.name));
    for (const essential of recoveryTools) expect(names, essential).toContain(essential);
    expect(names).toContain('search');
  });

  it('prunes the lowest-ranked non-essential tools when the mounted set is small', async () => {
    const k = offlineKernel();
    const tools = ['read', 'bash', 'write_file', 'deploy', 'notify', 'sync-cloud'].map((n) =>
      fakeTool(n),
    );
    forceAllocation(k, tier3(['read']));
    const plan = await k.planTurn({ objective: 'edit', allTools: tools, defaultMaxTokens: 1000 });
    const names = plan.tools.map((t) => t.name);
    expect(names).toContain('read');
    expect(names).toContain('bash');
    expect(names).toContain('write_file');
    expect(names).not.toContain('deploy');
    expect(names).not.toContain('notify');
    expect(names).not.toContain('sync-cloud');
  });

  it('honors configured essentialTools even when the router mounts nothing relevant', async () => {
    const k = offlineKernel({ essentialTools: ['mcp__acme__edit'] });
    const tools = ['read', 'bash', 'mcp__acme__edit', 'deploy'].map((n) => fakeTool(n));
    forceAllocation(k, tier3(['read']));
    const plan = await k.planTurn({ objective: 'edit', allTools: tools, defaultMaxTokens: 1000 });
    expect(plan.tools.map((t) => t.name)).toContain('mcp__acme__edit');
    expect(plan.tools.map((t) => t.name)).not.toContain('deploy');
  });

  it('reports the dropped (pruned) tool names on the plan', async () => {
    const k = offlineKernel();
    const tools = ['read', 'bash', 'deploy', 'notify'].map((n) => fakeTool(n));
    forceAllocation(k, tier3(['read']));
    const plan = await k.planTurn({ objective: 'edit', allTools: tools, defaultMaxTokens: 1000 });
    expect(plan.droppedTools).toEqual(['deploy', 'notify']);
  });

  it('catalog.select never exceeds the mounted cap and evicts lowest-ranked, never pins', () => {
    const c = new CapabilityCatalog();
    c.load(syntheticCatalog(300));
    const pin = c
      .select({ query: 'browser test', maxMounted: 5 })
      .mounted.slice(0, 2)
      .map((m) => m.id);
    // Select with a pin and a tight cap: total mounted must not exceed the cap.
    const { mounted, removed } = c.select({ query: 'post to slack', maxMounted: 4, pin });
    expect(mounted.length).toBeLessThanOrEqual(4);
    // Pinned ids are never evicted.
    for (const id of pin) expect(mounted.some((m) => m.id === id)).toBe(true);
    expect(removed.length).toBe(0);
  });
});

describe('S6 audit: BM25 & semantic ranker determinism', () => {
  it('rankEntries returns identical ordering across identically-built catalogs', () => {
    const build = () => {
      const c = new CapabilityCatalog();
      c.load(syntheticCatalog(300));
      return c;
    };
    const a = build().rankEntries('post to slack and file a linear ticket', 25);
    const b = build().rankEntries('post to slack and file a linear ticket', 25);
    expect(a.map((r) => r.entry.id)).toEqual(b.map((r) => r.entry.id));
    expect(a.map((r) => r.score)).toEqual(b.map((r) => r.score));
  });

  it('rankEntries is stable across repeated identical queries on the same catalog', () => {
    const c = new CapabilityCatalog();
    c.load(syntheticCatalog(300));
    const first = c.rankEntries('run a browser smoke test', 25);
    const second = c.rankEntries('run a browser smoke test', 25);
    expect(first.map((r) => r.entry.id)).toEqual(second.map((r) => r.entry.id));
  });

  it('chooseMountSet is deterministic: identical inputs select the same mount ids', () => {
    const build = () => {
      const c = new CapabilityCatalog();
      c.load(syntheticCatalog(300));
      return c;
    };
    const q = 'post to slack and open a linear ticket';
    const a = build()
      .select({ query: q, maxMounted: 6 })
      .mounted.map((m) => m.id);
    const b = build()
      .select({ query: q, maxMounted: 6 })
      .mounted.map((m) => m.id);
    expect(a).toEqual(b);
  });

  it('heuristicAllocate is deterministic across identical inputs', () => {
    const top = [...Array(10)].map((_, i) => ({
      kind: 'tool' as const,
      id: `tool:${i}`,
      name: `tool:${i}`,
      description: `capability ${i}`,
      tokens: [`capability`, String(i)],
    }));
    const req = {
      objective: 'fix the failing test',
      stateDelta: '',
      telemetry: {
        frictionScore: 1.5,
        contextPressure: 0.5,
        epistemicUncertainty: 0.3,
        consecutiveFailures: 1,
        lastToolSignature: '',
        turn: 1,
      },
      candidates: top,
      profile: { maxWindow: 100_000, attentionCeiling: 0.65, maxMountedTools: 6 },
    };
    const a = heuristicAllocate(req, top);
    const b = heuristicAllocate(req, top);
    expect(a).toEqual(b);
    expect(a.mountedTools).toEqual(b.mountedTools);
  });
});

describe('S6 audit: zero empty-set fallback under pressure/friction', () => {
  it('tier-3 with an empty mounted list still exposes every recovery tool (never empty)', async () => {
    const k = offlineKernel();
    const tools = recoveryTools.map((n) => fakeTool(n));
    forceAllocation(k, tier3([]));
    const plan = await k.planTurn({
      objective: 'recover',
      allTools: tools,
      defaultMaxTokens: 1000,
    });
    const names = plan.tools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    for (const essential of recoveryTools) expect(names, essential).toContain(essential);
  });

  it('under friction >= 1 the recovery tools are never stripped', async () => {
    const k = offlineKernel();
    const tools = [...recoveryTools, 'deploy'].map((n) => fakeTool(n));
    // Drive friction >= 1 (syntax error bump 1.5 + exit bump 1.25).
    k.telemetry.observeTool({
      tool: 'bash',
      inputSummary: 'npm test',
      isError: true,
      kind: 'syntax',
    });
    k.telemetry.observeTool({
      tool: 'bash',
      inputSummary: 'go build',
      isError: true,
      kind: 'exit',
    });
    expect(k.telemetry.snapshot().frictionScore).toBeGreaterThanOrEqual(1);

    forceAllocation(k, tier3(['read']));
    const plan = await k.planTurn({
      objective: 'fix build',
      allTools: tools,
      defaultMaxTokens: 1000,
    });
    const names = new Set(plan.tools.map((t) => t.name));
    for (const essential of ['read', 'bash', 'str_replace', 'write_file']) {
      expect(names, essential).toContain(essential);
    }
    expect(plan.tools.length).toBeGreaterThan(0);
  });

  it('under extreme context pressure the tool set is never empty and keeps essentials', async () => {
    const k = offlineKernel();
    const tools = [...recoveryTools, 'deploy'].map((n) => fakeTool(n));
    forceAllocation(k, tier3(['read']));
    // 200k prompt tokens vs a 65k ceiling => pressure clamps to 2 (extreme).
    const plan = await k.planTurn({
      objective: 'continue the task',
      allTools: tools,
      defaultMaxTokens: 1000,
      promptTokens: 200_000,
    });
    const names = new Set(plan.tools.map((t) => t.name));
    expect(plan.tools.length).toBeGreaterThan(0);
    for (const essential of ['read', 'bash', 'str_replace', 'write_file']) {
      expect(names, essential).toContain(essential);
    }
  });
});
