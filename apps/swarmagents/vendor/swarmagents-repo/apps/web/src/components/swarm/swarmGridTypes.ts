/**
 * Shared data model for the swarm topology grid (SwarmGrid / AgentRoleCard).
 *
 * The mapping helpers live here — with no React and no CSS imports — so they can
 * be unit-tested under a plain runner and reused by any host page that has the
 * app's canonical HierarchyAgent list.
 */

import type { HierarchyAgent } from '@/lib/swarmHierarchy';
import type { SandboxStatus } from '@/lib/sandboxTypes';

/** Normalized four-state status shown on a role card. */
export type SwarmStatus = 'working' | 'idle' | 'paused' | 'error';

/** Canonical seat roles -> badge labels. Auditor/DevOps accept their aliases. */
export const ROLE_BADGE_LABELS: Readonly<Record<string, string>> = {
  orchestrator: 'Orchestrator',
  researcher: 'Researcher',
  implementer: 'Implementer',
  auditor: 'Auditor',
  'security-auditor': 'Auditor',
  devops: 'DevOps',
  'devops-engineer': 'DevOps',
};

/** Role badge label for a role id; falls back to a Title-Cased id form. */
export function roleBadgeLabel(roleId: string): string {
  const mapped = ROLE_BADGE_LABELS[roleId];
  if (mapped) return mapped;
  return roleId
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Map raw sandbox status + activity to the card's four-state status. */
export function toSwarmStatus(status: SandboxStatus | undefined, activity?: string): SwarmStatus {
  if (status === 'paused') return 'paused';
  if (status === 'error') return 'error';
  if (status === 'running' || activity === 'working' || activity === 'communicating') {
    return 'working';
  }
  return 'idle';
}

/** One active worker rendered as a row in the topology grid. */
export interface GridAgent {
  id: string;
  name: string;
  /** Seat id; drives the role badge (orchestrator, researcher, …). */
  roleId: string;
  /** Active LLM model tag, e.g. "claude-sonnet-5-5". */
  model?: string;
  status: SwarmStatus;
  /** Monotonic turn counter; refreshed live from the stream store when available. */
  turnCounter: number;
  /** Current task brief, previewed when the card is selected. */
  taskBrief?: string;
  /** Tools the agent may call, previewed when the card is selected. */
  toolWhitelist?: string[];
}

/** Build a grid row from the app's canonical hierarchy agent. */
export function gridAgentFromHierarchy(agent: HierarchyAgent): GridAgent {
  return {
    id: agent.id,
    name: agent.label || agent.roleId,
    roleId: agent.roleId,
    model: agent.assignedModel,
    status: toSwarmStatus(agent.status, agent.activity),
    turnCounter: 0,
  };
}
