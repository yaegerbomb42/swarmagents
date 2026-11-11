import { describe, it, expect, beforeEach } from 'vitest';
import {
  CONDENSER_ROLE,
  SEED_ROLE_CARDS,
  listRoleCards,
  saveRoleCard,
  toggleRoleVisibility,
  forkRoleCard,
  roleCardFromSynthesis,
  _resetRoleLibraryForTests,
} from './roleLibrary';

describe('roleLibrary', () => {
  beforeEach(() => {
    _resetRoleLibraryForTests();
  });

  it('includes the built-in Context Condenser seed role', () => {
    expect(SEED_ROLE_CARDS).toHaveLength(1);
    expect(CONDENSER_ROLE.roleId).toBe('context-condenser');
    expect(CONDENSER_ROLE.contextInputRange).toContain('262k');
    expect(CONDENSER_ROLE.contextOutputRange).toContain('4k');
    expect(CONDENSER_ROLE.usageContexts).toContain('orchestration');
    expect(CONDENSER_ROLE.isPublic).toBe(true);
    expect(CONDENSER_ROLE.isBuiltin).toBe(true);
  });

  it('lists public roles in global scope', async () => {
    const publicRoles = await listRoleCards({ scope: 'public' });
    expect(publicRoles.some((r) => r.roleId === 'context-condenser')).toBe(true);
  });

  it('saves and retrieves custom private roles', async () => {
    const custom = roleCardFromSynthesis(
      {
        roleId: 'test-auditor',
        name: 'Test Auditor',
        description: 'Audits things',
        responsibility: 'Audit',
        suggestedTools: ['search'],
        recommendedModelTier: 'strong',
        color: 'from-cyan-400 to-blue-500',
        contextDna: {
          systemDirective: 'Audit everything.',
          personaTone: 'Strict',
          reasoningRules: [],
          outputConstraints: [],
          specializedKnowledge: [],
          temperature: 0.1,
        },
      },
      { domainDescription: 'auditing', isPublic: false, ownerId: 'usr-test', ownerName: 'Tester' }
    );

    await saveRoleCard(custom);

    const mine = await listRoleCards({ scope: 'private', ownerId: 'usr-test' });
    expect(mine.some((r) => r.roleId === 'test-auditor')).toBe(true);

    const global = await listRoleCards({ scope: 'public' });
    expect(global.some((r) => r.roleId === 'test-auditor')).toBe(false);
  });

  it('toggles role visibility from private to public', async () => {
    const custom = roleCardFromSynthesis(
      { roleId: 'toggle-test', name: 'Toggle Test', description: 'x' },
      { domainDescription: 'test', isPublic: false, ownerId: 'usr-toggle', ownerName: 'T' }
    );
    await saveRoleCard(custom);

    const toggled = await toggleRoleVisibility('toggle-test', true, 'usr-toggle');
    expect(toggled?.isPublic).toBe(true);

    const global = await listRoleCards({ scope: 'public' });
    expect(global.some((r) => r.roleId === 'toggle-test')).toBe(true);
  });

  it('forks a role into a private draft owned by the forker', async () => {
    const forked = await forkRoleCard('context-condenser', {
      ownerId: 'usr-fork',
      ownerName: 'Forker',
    });

    expect(forked).not.toBeNull();
    expect(forked!.name).toContain('(Fork)');
    expect(forked!.isPublic).toBe(false);
    expect(forked!.isBuiltin).toBe(false);
    expect(forked!.ownerId).toBe('usr-fork');
    expect(forked!.roleId).not.toBe('context-condenser');

    const mine = await listRoleCards({ scope: 'private', ownerId: 'usr-fork' });
    expect(mine.some((r) => r.roleId === forked!.roleId)).toBe(true);
  });
});
