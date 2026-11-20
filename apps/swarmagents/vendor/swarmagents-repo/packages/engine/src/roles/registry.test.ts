import { describe, expect, it } from 'vitest';
import {
  RoleRegistry,
  RoleCycleError,
  RoleParentError,
  RoleValidationError,
} from './registry.js';
import { implementerRole } from './builtin-roles.js';
import type { RoleDefinition } from './types.js';

const stub = (overrides: Partial<RoleDefinition>): RoleDefinition => ({
  id: overrides.id ?? 'stub',
  name: overrides.name ?? overrides.id ?? 'Stub',
  ...overrides,
});

describe('RoleRegistry', () => {
  it('has built-in roles by default', () => {
    const r = new RoleRegistry();
    expect(r.has('orchestrator')).toBe(true);
    expect(r.has('implementer')).toBe(true);
    expect(r.has('researcher')).toBe(true);
    expect(r.has('auditor')).toBe(true);
    expect(r.has('devops')).toBe(true);
    expect(r.list()).toEqual(['orchestrator', 'researcher', 'implementer', 'auditor', 'devops']);
  });

  it('resolves the coder alias to implementer', () => {
    const r = new RoleRegistry();
    expect(r.has('coder')).toBe(true);
    expect(r.get('coder')).toBe(r.get('implementer'));
    expect(r.get('coder')?.id).toBe('implementer');
    expect(r.get('coder')).toEqual(implementerRole);
    expect(r.list().includes('coder')).toBe(false);
  });

  it('lets a custom coder registration override the alias', () => {
    const r = new RoleRegistry();
    r.register(stub({ id: 'coder', name: 'Custom Coder', allowedTools: ['read'] }));
    const got = r.get('coder');
    expect(got?.id).toBe('coder');
    expect(got?.name).toBe('Custom Coder');
    expect(got?.allowedTools).toEqual(['read']);
    expect(r.get('implementer')?.id).toBe('implementer');
  });

  it('registers and retrieves a custom role', () => {
    const r = new RoleRegistry();
    const def = stub({ id: 'custom', name: 'Custom' });
    r.register(def);
    expect(r.has('custom')).toBe(true);
    const got = r.get('custom');
    expect(got).toBeDefined();
    expect(got!.id).toBe('custom');
    expect(got!.name).toBe('Custom');
  });

  it('resolves inheritance and allows custom override of a built-in', () => {
    const r = new RoleRegistry();
    r.register(stub({ id: 'parent', name: 'Parent', maxTurns: 10, allowedTools: ['read', 'bash'] }));
    r.register(
      stub({ id: 'child', name: 'Child', extends: 'parent', maxTurns: 5, allowedTools: ['read'] }),
    );
    const child = r.get('child');
    expect(child!.maxTurns).toBe(5);
    expect(child!.allowedTools).toEqual(['read']);
    expect(child!.name).toBe('Child');
  });

  it('inherits missing fields from parent', () => {
    const r = new RoleRegistry();
    r.register(stub({ id: 'parent2', name: 'P', description: 'd', maxTurns: 12 }));
    r.register(stub({ id: 'child2', name: 'C', extends: 'parent2' }));
    const child = r.get('child2');
    expect(child!.description).toBe('d');
    expect(child!.maxTurns).toBe(12);
  });

  it('overrides a built-in when the same id is re-registered', () => {
    const r = new RoleRegistry();
    r.register(
      stub({
        id: 'researcher',
        name: 'Workspace Researcher',
        allowedTools: ['read'],
        permissions: { readOnly: true, networkAllowed: false, commandExecutionAllowed: false },
      }),
    );
    const got = r.get('researcher');
    expect(got!.name).toBe('Workspace Researcher');
    expect(got!.allowedTools).toEqual(['read']);
  });

  it('throws on cycle', () => {
    const r = new RoleRegistry();
    r.register(stub({ id: 'a', name: 'A', extends: 'b' }));
    r.register(stub({ id: 'b', name: 'B', extends: 'c' }));
    r.register(stub({ id: 'c', name: 'C', extends: 'a' }));
    expect(() => r.get('a')).toThrow(RoleCycleError);
  });

  it('throws on unknown parent', () => {
    const r = new RoleRegistry();
    r.register(stub({ id: 'orphan', name: 'O', extends: 'nosuch' }));
    expect(() => r.get('orphan')).toThrow(RoleParentError);
  });

  it('throws on invalid role after merge', () => {
    const r = new RoleRegistry();
    r.register(stub({ id: 'bad', name: '', maxTurns: -1 }));
    expect(() => r.get('bad')).toThrow(RoleValidationError);
  });

  it('resolves built-in inheritance', () => {
    const r = new RoleRegistry();
    r.register(stub({ id: 'my-coder', name: 'My Coder', extends: 'implementer' }));
    const got = r.get('my-coder');
    expect(got!.allowedTools).toEqual(r.get('implementer')!.allowedTools);
    expect(got!.name).toBe('My Coder');
    expect(got!.modelConfig?.modelId).toBe('claude-sonnet');
  });

  it('caches resolved roles', () => {
    const r = new RoleRegistry();
    r.register(stub({ id: 'c', name: 'C' }));
    const a = r.get('c');
    const b = r.get('c');
    expect(a).toBe(b);
  });

  it('reset clears custom roles only', () => {
    const r = new RoleRegistry();
    r.register(stub({ id: 'temp', name: 'Temp' }));
    expect(r.has('temp')).toBe(true);
    r.reset();
    expect(r.has('temp')).toBe(false);
    expect(r.has('orchestrator')).toBe(true);
  });
});
