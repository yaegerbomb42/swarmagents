import { describe, expect, it } from 'vitest';
import { mergeRole } from './merge.js';
import type { RoleDefinition } from './types.js';

const base: RoleDefinition = {
  id: 'base',
  name: 'Base',
  description: 'base desc',
  modelConfig: {
    provider: 'anthropic',
    modelId: 'claude-sonnet',
    maxTokens: 100,
    temperature: 0.5,
    maxTurns: 20,
  },
  allowedTools: ['read', 'bash'],
  mcpServers: [{ name: 'a', load: 'lazy' }],
  systemPrompt: 'base prompt',
  permissions: { readOnly: true, networkAllowed: false, commandExecutionAllowed: true },
  maxTurns: 20,
  maxDeadlineMs: 300_000,
};

describe('mergeRole', () => {
  it('child overrides scalar fields', () => {
    const child: RoleDefinition = {
      id: 'child',
      name: 'Child',
      description: 'child desc',
      maxTurns: 10,
    };
    const m = mergeRole(base, child);
    expect(m.name).toBe('Child');
    expect(m.description).toBe('child desc');
    expect(m.maxTurns).toBe(10);
  });

  it('child replaces arrays', () => {
    const child: RoleDefinition = {
      id: 'child',
      name: 'Child',
      allowedTools: ['read'],
    };
    const m = mergeRole(base, child);
    expect(m.allowedTools).toEqual(['read']);
    expect(m.mcpServers).toEqual([{ name: 'a', load: 'lazy' }]);
  });

  it('child inherits missing arrays', () => {
    const child: RoleDefinition = { id: 'child', name: 'Child' };
    const m = mergeRole(base, child);
    expect(m.allowedTools).toEqual(['read', 'bash']);
    expect(m.mcpServers).toEqual([{ name: 'a', load: 'lazy' }]);
  });

  it('child deep-merges modelConfig', () => {
    const child: RoleDefinition = {
      id: 'child',
      name: 'Child',
      modelConfig: { temperature: 0.9 },
    };
    const m = mergeRole(base, child);
    expect(m.modelConfig).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet',
      maxTokens: 100,
      temperature: 0.9,
      maxTurns: 20,
    });
  });

  it('child deep-merges permissions', () => {
    const child: RoleDefinition = {
      id: 'child',
      name: 'Child',
      permissions: { readOnly: false },
    };
    const m = mergeRole(base, child);
    expect(m.permissions).toEqual({
      readOnly: false,
      networkAllowed: false,
      commandExecutionAllowed: true,
    });
  });

  it('clears extends after merge', () => {
    const child: RoleDefinition = {
      id: 'child',
      name: 'Child',
      extends: 'base',
    };
    const m = mergeRole(base, child);
    expect(m.extends).toBeUndefined();
  });
});
