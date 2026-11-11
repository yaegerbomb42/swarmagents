import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRolesFromYaml, loadRolesFromJson, loadRoleFiles } from './loader.js';
import { RoleRegistry } from './registry.js';

describe('loadRolesFromYaml', () => {
  it('loads a single role', () => {
    const yaml = `id: my-role
name: My Role
maxTurns: 10`;
    const { roles, errors } = loadRolesFromYaml(yaml);
    expect(errors).toHaveLength(0);
    expect(roles).toHaveLength(1);
    expect(roles[0]!.id).toBe('my-role');
    expect(roles[0]!.name).toBe('My Role');
    expect(roles[0]!.maxTurns).toBe(10);
  });

  it('loads an array of roles', () => {
    const yaml = `- id: a
  name: A
- id: b
  name: B`;
    const { roles, errors } = loadRolesFromYaml(yaml);
    expect(errors).toHaveLength(0);
    expect(roles).toHaveLength(2);
    expect(roles[0]!.id).toBe('a');
    expect(roles[1]!.id).toBe('b');
  });

  it('unwraps a roles: wrapper', () => {
    const yaml = `roles:
  - id: a
    name: A`;
    const { roles, errors } = loadRolesFromYaml(yaml);
    expect(errors).toHaveLength(0);
    expect(roles.map((r) => r.id)).toEqual(['a']);
  });

  it('handles nested modelConfig', () => {
    const yaml = `id: coder
name: Coder
modelConfig:
  provider: anthropic
  modelId: claude-sonnet
  maxTokens: 8192
  temperature: 0.2`;
    const { roles } = loadRolesFromYaml(yaml);
    expect(roles[0]!.modelConfig).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet',
      maxTokens: 8192,
      temperature: 0.2,
    });
  });

  it('handles permissions and mcpServers', () => {
    const yaml = `id: reader
name: Reader
permissions:
  readOnly: true
  networkAllowed: false
  commandExecutionAllowed: false
mcpServers:
  - name: docs
    load: eager
  - web`;
    const { roles } = loadRolesFromYaml(yaml);
    expect(roles[0]!.permissions).toEqual({
      readOnly: true,
      networkAllowed: false,
      commandExecutionAllowed: false,
    });
    expect(roles[0]!.mcpServers).toEqual([
      { name: 'docs', load: 'eager' },
      { name: 'web', load: 'lazy' },
    ]);
  });

  it('handles allowedTools array and extends', () => {
    const yaml = `id: restricted
name: R
extends: researcher
allowedTools:
  - read
  - search`;
    const { roles } = loadRolesFromYaml(yaml);
    expect(roles[0]!.allowedTools).toEqual(['read', 'search']);
    expect(roles[0]!.extends).toBe('researcher');
  });

  it('reports error for missing id', () => {
    const yaml = `name: No ID`;
    const { roles, errors } = loadRolesFromYaml(yaml);
    expect(roles).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('loadRolesFromJson', () => {
  it('loads a single role object', () => {
    const json = JSON.stringify({ id: 'j', name: 'J', maxTurns: 5 });
    const { roles, errors } = loadRolesFromJson(json);
    expect(errors).toHaveLength(0);
    expect(roles).toHaveLength(1);
    expect(roles[0]!.id).toBe('j');
  });

  it('loads an array of roles and a roles wrapper', () => {
    const json = JSON.stringify({ roles: [{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }] });
    const { roles, errors } = loadRolesFromJson(json);
    expect(errors).toHaveLength(0);
    expect(roles).toHaveLength(2);
  });

  it('reports error for invalid JSON', () => {
    const { roles, errors } = loadRolesFromJson('not json');
    expect(roles).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('loadRoleFiles + custom override', () => {
  it('loads roles.yaml and registers an override with extends', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'roles-'));
    await writeFile(
      join(dir, 'roles.yaml'),
      `id: researcher
name: Workspace Researcher
extends: researcher
allowedTools:
  - read
  - search
`,
    );
    const { roles, errors } = await loadRoleFiles(dir);
    expect(errors).toHaveLength(0);
    expect(roles).toHaveLength(1);
    const registry = new RoleRegistry();
    registry.registerMany(roles);
    const got = registry.get('researcher');
    expect(got!.name).toBe('Workspace Researcher');
    expect(got!.allowedTools).toEqual(['read', 'search']);
    expect(got!.permissions?.readOnly).toBe(true);
    expect(got!.modelConfig?.modelId).toBe('claude-haiku');
  });

  it('loads .roles.json when no yaml is present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'roles-'));
    await writeFile(join(dir, '.roles.json'), JSON.stringify([{ id: 'extra', name: 'Extra' }]));
    const { roles, errors } = await loadRoleFiles(dir);
    expect(errors).toHaveLength(0);
    expect(roles[0]!.id).toBe('extra');
  });
});
