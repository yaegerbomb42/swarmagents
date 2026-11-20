import { describe, expect, it } from 'vitest';
import {
  clampedTurnCeiling,
  clampedDeadlineMs,
  filteredTools,
  isToolAllowed,
  clampedMaxTokens,
  roleSystemPrompt,
  assertToolAllowed,
  RoleToolDeniedError,
  toolDenialReason,
  roleModelRoute,
  raceAbort,
} from './filter.js';
import { applyRoleToLoopDeps } from './bind.js';
import { researcherRole, implementerRole, auditorRole } from './builtin-roles.js';
import type { RoleDefinition } from './types.js';
import type { Tool } from '../tools/types.js';

function makeTool(name: string): Tool {
  return { name } as Tool;
}

describe('clampedTurnCeiling', () => {
  it('clamps when role maxTurns is lower', () => {
    const role: RoleDefinition = { id: 'r', name: 'R', maxTurns: 8 };
    expect(clampedTurnCeiling(role, 20)).toBe(8);
  });

  it('honors modelConfig.maxTurns over the shorthand', () => {
    const role: RoleDefinition = {
      id: 'r',
      name: 'R',
      maxTurns: 8,
      modelConfig: { provider: 'p', modelId: 'm', maxTurns: 3 },
    };
    expect(clampedTurnCeiling(role, 20)).toBe(3);
  });

  it('returns global when no role', () => {
    expect(clampedTurnCeiling(undefined, 20)).toBe(20);
  });
});

describe('clampedDeadlineMs', () => {
  it('uses role deadline when global is later', () => {
    const role: RoleDefinition = { id: 'r', name: 'R', maxDeadlineMs: 300_000 };
    expect(clampedDeadlineMs(role, 1_000_000, 0)).toBe(300_000);
  });

  it('uses global when role is later', () => {
    const role: RoleDefinition = { id: 'r', name: 'R', maxDeadlineMs: 900_000 };
    expect(clampedDeadlineMs(role, 600_000, 0)).toBe(600_000);
  });

  it('returns role deadline without global', () => {
    const role: RoleDefinition = { id: 'r', name: 'R', maxDeadlineMs: 120_000 };
    expect(clampedDeadlineMs(role, undefined, 0)).toBe(120_000);
  });

  it('returns undefined when neither is set', () => {
    expect(clampedDeadlineMs(undefined, undefined, 0)).toBeUndefined();
  });
});

describe('filteredTools', () => {
  it('filters to allowed tools only', () => {
    const tools = [makeTool('read'), makeTool('bash'), makeTool('write_file')];
    const role: RoleDefinition = { id: 'r', name: 'R', allowedTools: ['read', 'bash'] };
    const out = filteredTools(role, tools);
    expect(out.map((t) => t.name)).toEqual(['read', 'bash']);
  });

  it('returns all tools when role has no whitelist', () => {
    const tools = [makeTool('read'), makeTool('bash')];
    expect(filteredTools(undefined, tools)).toEqual(tools);
    expect(filteredTools({ id: 'r', name: 'R' }, tools)).toEqual(tools);
  });
});

describe('tool whitelist and permission enforcement', () => {
  it('allows listed tools and denies others', () => {
    const role: RoleDefinition = { id: 'r', name: 'R', allowedTools: ['read'] };
    expect(isToolAllowed(role, 'read')).toBe(true);
    expect(isToolAllowed(role, 'bash')).toBe(false);
    expect(() => assertToolAllowed(role, 'bash')).toThrow(RoleToolDeniedError);
  });

  it('allows everything when no whitelist and no denying permissions', () => {
    expect(isToolAllowed(undefined, 'anything')).toBe(true);
  });

  it('researcher cannot edit or run commands', () => {
    expect(isToolAllowed(researcherRole, 'read')).toBe(true);
    expect(isToolAllowed(researcherRole, 'web_search')).toBe(true);
    expect(isToolAllowed(researcherRole, 'write_file')).toBe(false);
    expect(isToolAllowed(researcherRole, 'str_replace')).toBe(false);
    expect(isToolAllowed(researcherRole, 'bash')).toBe(false);
    expect(toolDenialReason(researcherRole, 'write_file')).toMatch(/whitelist|read-only/);
    expect(() => assertToolAllowed(researcherRole, 'write_file')).toThrow(RoleToolDeniedError);
  });

  it('implementer can edit and run a scoped test runner', () => {
    expect(isToolAllowed(implementerRole, 'write_file')).toBe(true);
    expect(isToolAllowed(implementerRole, 'bash')).toBe(true);
    expect(isToolAllowed(implementerRole, 'web_search')).toBe(false);
  });

  it('auditor may run checks but not write product files', () => {
    expect(isToolAllowed(auditorRole, 'bash')).toBe(true);
    expect(isToolAllowed(auditorRole, 'read')).toBe(true);
    expect(isToolAllowed(auditorRole, 'write_file')).toBe(false);
  });

  it('permission flags deny even if a tool is mistakenly whitelisted', () => {
    const role: RoleDefinition = {
      id: 'locked',
      name: 'Locked',
      allowedTools: ['read', 'write_file', 'bash', 'web_search'],
      permissions: { readOnly: true, networkAllowed: false, commandExecutionAllowed: false },
    };
    expect(isToolAllowed(role, 'read')).toBe(true);
    expect(isToolAllowed(role, 'write_file')).toBe(false);
    expect(isToolAllowed(role, 'bash')).toBe(false);
    expect(isToolAllowed(role, 'web_search')).toBe(false);
  });
});

describe('per-role model routing', () => {
  it('routes each built-in to its provider and model id', () => {
    const researcher = roleModelRoute(researcherRole);
    expect(researcher).toMatchObject({ provider: 'anthropic', modelId: 'claude-haiku' });
    const implementer = roleModelRoute(implementerRole);
    expect(implementer).toMatchObject({ provider: 'anthropic', modelId: 'claude-sonnet', temperature: 0.1 });
  });

  it('throws when provider or modelId is missing', () => {
    expect(() => roleModelRoute({ id: 'x', name: 'X' })).toThrow(/modelConfig/);
  });
});

describe('clampedMaxTokens and system prompt', () => {
  it('clamps to role maxTokens', () => {
    const role: RoleDefinition = {
      id: 'r',
      name: 'R',
      modelConfig: { provider: 'p', modelId: 'm', maxTokens: 4096 },
    };
    expect(clampedMaxTokens(role, 8192)).toBe(4096);
  });

  it('returns the prompt when set', () => {
    const role: RoleDefinition = { id: 'r', name: 'R', systemPrompt: 'Be careful.' };
    expect(roleSystemPrompt(role)).toBe('Be careful.');
  });
});

describe('applyRoleToLoopDeps', () => {
  it('clamps budget, tokens, deadline and filters tools', () => {
    const tools = [makeTool('read'), makeTool('bash'), makeTool('write_file')];
    const applied = applyRoleToLoopDeps({
      role: researcherRole,
      budget: { max_turns_per_cycle: 100 },
      maxTokens: 100_000,
      deadlineMs: 10_000_000,
      tools,
      clock: { now: () => 0 },
    });
    expect(applied.budget.max_turns_per_cycle).toBe(researcherRole.maxTurns);
    expect(applied.maxTokens).toBe(researcherRole.modelConfig!.maxTokens);
    expect(applied.deadlineMs).toBe(researcherRole.maxDeadlineMs);
    expect(applied.tools.map((t) => t.name)).toEqual(['read']);
  });

  it('is a no-op without a role', () => {
    const deps = {
      budget: { max_turns_per_cycle: 9 },
      maxTokens: 100,
      tools: [makeTool('bash')],
      clock: { now: () => 1 },
    };
    expect(applyRoleToLoopDeps(deps)).toBe(deps);
  });
});

describe('raceAbort', () => {
  it('resolves when the signal is not aborted', async () => {
    await expect(raceAbort(Promise.resolve(42))).resolves.toBe(42);
  });

  it('rejects when the signal is already aborted', async () => {
    const c = new AbortController();
    c.abort('stop');
    await expect(raceAbort(new Promise(() => undefined), c.signal)).rejects.toThrow(/stop/);
  });
});
