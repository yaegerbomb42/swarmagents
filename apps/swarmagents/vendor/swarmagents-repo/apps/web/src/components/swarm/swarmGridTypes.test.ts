import { describe, expect, it } from 'vitest';
import {
  gridAgentFromHierarchy,
  roleBadgeLabel,
  toSwarmStatus,
  type GridAgent,
} from './swarmGridTypes';

describe('roleBadgeLabel', () => {
  it('maps the canonical seat roles to their badges', () => {
    expect(roleBadgeLabel('orchestrator')).toBe('Orchestrator');
    expect(roleBadgeLabel('researcher')).toBe('Researcher');
    expect(roleBadgeLabel('implementer')).toBe('Implementer');
    expect(roleBadgeLabel('auditor')).toBe('Auditor');
    expect(roleBadgeLabel('devops-engineer')).toBe('DevOps');
    expect(roleBadgeLabel('security-auditor')).toBe('Auditor');
  });

  it('falls back to a title-cased label for unknown seats', () => {
    expect(roleBadgeLabel('merge-resolver')).toBe('Merge Resolver');
    expect(roleBadgeLabel('qa-engineer')).toBe('Qa Engineer');
  });
});

describe('toSwarmStatus', () => {
  it('maps running or active activity to working', () => {
    expect(toSwarmStatus('running')).toBe('working');
    expect(toSwarmStatus('idle', 'working')).toBe('working');
    expect(toSwarmStatus('idle', 'communicating')).toBe('working');
  });

  it('prioritizes error and paused states', () => {
    expect(toSwarmStatus('error')).toBe('error');
    expect(toSwarmStatus('paused')).toBe('paused');
    expect(toSwarmStatus('paused', 'working')).toBe('paused');
  });

  it('defaults to idle', () => {
    expect(toSwarmStatus('idle')).toBe('idle');
    expect(toSwarmStatus('done')).toBe('idle');
    expect(toSwarmStatus(undefined)).toBe('idle');
  });
});

describe('gridAgentFromHierarchy', () => {
  it('builds a grid row from a hierarchy agent', () => {
    const row: GridAgent = gridAgentFromHierarchy({
      id: 'role:researcher',
      roleId: 'researcher',
      parentId: null,
      status: 'running',
      label: 'Researcher',
      assignedModel: 'claude-sonnet-5-5',
      activity: 'working',
      live: true,
    });
    expect(row.name).toBe('Researcher');
    expect(row.roleId).toBe('researcher');
    expect(row.status).toBe('working');
    expect(row.model).toBe('claude-sonnet-5-5');
    expect(row.turnCounter).toBe(0);
  });
});
