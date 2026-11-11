/**
 * SwarmAgents Role Library — shared global + per-user role catalog
 *
 * Roles are model cards describing specialized LLM agents for workflows,
 * decomposition trajectories, and orchestration handoffs.
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { PromptContextDna } from './agentEvolution';

export type RoleUsageContext =
  | 'workflow'
  | 'decomposition'
  | 'manual'
  | 'orchestration';

export type ModelTier = 'frontier' | 'strong' | 'medium' | 'light';

export interface AgentRoleCard {
  roleId: string;
  name: string;
  category: string;
  description: string;
  responsibility: string;
  suggestedTools: string[];
  recommendedModelTier: ModelTier;
  color: string;
  contextDna: PromptContextDna;
  /** Input context window the role is designed to consume */
  contextInputRange: string;
  /** Target output size after processing */
  contextOutputRange: string;
  /** Where this role can be invoked */
  usageContexts: RoleUsageContext[];
  isPublic: boolean;
  isBuiltin: boolean;
  ownerId: string;
  ownerName: string;
  forkCount: number;
  useCount: number;
  createdAt: string;
  updatedAt: string;
}

const ROLES_DATA_PATH = path.join(process.cwd(), '.data', 'roles', 'library.json');

export const CONDENSER_ROLE: AgentRoleCard = {
  roleId: 'context-condenser',
  name: 'Context Condenser',
  category: 'operations',
  description:
    'Ingests 262k–1M token context windows and produces a 4–8k token professionally structured summary — matching the condensation format Antigravity and Cursor agents receive before long-horizon work.',
  responsibility:
    'Compress sprawling session history, file trees, tool traces, and decision logs into dense, actionable briefing documents without losing critical constraints, open threads, or architectural decisions.',
  suggestedTools: ['search', 'edit', 'memory'],
  recommendedModelTier: 'frontier',
  color: 'from-fuchsia-400 to-violet-600',
  contextInputRange: '262k – 1M tokens',
  contextOutputRange: '4k – 8k tokens',
  usageContexts: ['workflow', 'decomposition', 'manual', 'orchestration'],
  isPublic: true,
  isBuiltin: true,
  ownerId: 'swarm-frontier',
  ownerName: 'Swarm Frontier Lab',
  forkCount: 1240,
  useCount: 48200,
  contextDna: {
    systemDirective: `You are the Context Condenser — a specialized compression agent used inside SwarmAgents workflows and decomposition trajectories.

Your sole job: take an enormous context payload (262k–1M tokens) and return a 4–8k token professionally condensed briefing that downstream agents can act on immediately.

OUTPUT FORMAT (match Antigravity / Cursor agent condensation):
1. **Mission & Current Objective** — one paragraph, present tense
2. **Key Decisions Made** — bullet list with rationale
3. **Active Constraints** — hard rules, invariants, things NOT to change
4. **File & Symbol Map** — critical paths touched, with one-line purpose each
5. **Open Threads** — unresolved questions, blockers, pending verifications
6. **Recent Tool Activity** — condensed trace of last N significant actions
7. **Suggested Next Actions** — ordered, atomic, executable

RULES:
- Never hallucinate files, decisions, or constraints not present in source context
- Preserve exact identifiers: file paths, function names, env vars, error messages
- Drop redundant tool output; keep only outcomes and deltas
- Use markdown headers; stay within 4–8k tokens
- Flag uncertainty explicitly with [UNVERIFIED] tags`,
    personaTone: 'Clinical, information-dense, zero filler. Like a staff engineer handing off a 6-month project in 5 minutes.',
    reasoningRules: [
      'Prioritize decisions and constraints over narrative history.',
      'Deduplicate repeated tool calls; keep latest state only.',
      'Preserve blockers and open questions — they are highest-signal.',
      'Quantify where possible: file counts, error rates, test status.',
    ],
    outputConstraints: [
      '4–8k tokens maximum output.',
      'Seven-section structure mandatory.',
      'No speculative additions beyond source material.',
    ],
    specializedKnowledge: [
      'Long-horizon agent session compression',
      'Cursor / Antigravity condensation schemas',
      'Swarm decomposition handoff protocols',
      'Context window economics',
    ],
    temperature: 0.1,
  },
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-31T00:00:00Z',
};

export const SEED_ROLE_CARDS: AgentRoleCard[] = [CONDENSER_ROLE];

let runtimeCustomRoles: AgentRoleCard[] = [];
let diskLoaded = false;

async function ensureDiskLoaded(): Promise<void> {
  if (diskLoaded) return;
  diskLoaded = true;
  try {
    const raw = await fs.readFile(ROLES_DATA_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      runtimeCustomRoles = parsed.filter((r) => !r.isBuiltin);
    }
  } catch {
    runtimeCustomRoles = [];
  }
}

async function persistCustomRoles(): Promise<void> {
  await fs.mkdir(path.dirname(ROLES_DATA_PATH), { recursive: true });
  await fs.writeFile(ROLES_DATA_PATH, JSON.stringify(runtimeCustomRoles, null, 2), 'utf-8');
}

export async function listRoleCards(options?: {
  scope?: 'all' | 'public' | 'private';
  ownerId?: string;
}): Promise<AgentRoleCard[]> {
  await ensureDiskLoaded();
  const scope = options?.scope ?? 'all';
  const ownerId = options?.ownerId ?? 'usr-local';

  const builtins = SEED_ROLE_CARDS;
  const custom = runtimeCustomRoles;

  const merged = [...builtins, ...custom];

  if (scope === 'public') {
    return merged.filter((r) => r.isPublic);
  }
  if (scope === 'private') {
    return merged.filter((r) => !r.isPublic && r.ownerId === ownerId);
  }
  return merged.filter((r) => r.isPublic || r.ownerId === ownerId);
}

export async function getRoleCard(roleId: string): Promise<AgentRoleCard | null> {
  const all = await listRoleCards({ scope: 'all' });
  return all.find((r) => r.roleId === roleId) ?? null;
}

export async function saveRoleCard(role: AgentRoleCard): Promise<AgentRoleCard> {
  await ensureDiskLoaded();

  if (role.isBuiltin) {
    throw new Error('Cannot modify built-in roles');
  }

  const idx = runtimeCustomRoles.findIndex((r) => r.roleId === role.roleId);
  const saved: AgentRoleCard = {
    ...role,
    isBuiltin: false,
    updatedAt: new Date().toISOString(),
  };

  if (idx >= 0) {
    runtimeCustomRoles[idx] = saved;
  } else {
    runtimeCustomRoles.unshift(saved);
  }

  await persistCustomRoles();
  return saved;
}

export async function toggleRoleVisibility(
  roleId: string,
  isPublic: boolean,
  ownerId = 'usr-local'
): Promise<AgentRoleCard | null> {
  await ensureDiskLoaded();
  const role = runtimeCustomRoles.find((r) => r.roleId === roleId && r.ownerId === ownerId);
  if (!role) return null;

  role.isPublic = isPublic;
  role.updatedAt = new Date().toISOString();
  await persistCustomRoles();
  return role;
}

export function roleCardFromSynthesis(
  parsed: Record<string, unknown>,
  options: {
    domainDescription: string;
    isPublic: boolean;
    ownerId: string;
    ownerName: string;
  }
): AgentRoleCard {
  const slug = String(parsed.roleId || `role-${Date.now().toString(36)}`);
  const contextDna = (parsed.contextDna as PromptContextDna) || {
    systemDirective: `You are an expert specialist focused on: ${options.domainDescription}.`,
    personaTone: 'Focused, methodical, domain-expert.',
    reasoningRules: ['Check all edge cases.', 'Deliver verified artifacts.'],
    outputConstraints: ['Structured and deterministic output.'],
    specializedKnowledge: [options.domainDescription],
    temperature: 0.2,
  };

  const now = new Date().toISOString();

  return {
    roleId: slug,
    name: String(parsed.name || 'Specialized Agent'),
    category: String(parsed.category || 'specialist'),
    description: String(parsed.description || ''),
    responsibility: String(parsed.responsibility || ''),
    suggestedTools: Array.isArray(parsed.suggestedTools)
      ? (parsed.suggestedTools as string[])
      : ['edit', 'search'],
    recommendedModelTier: (parsed.recommendedModelTier as ModelTier) || 'strong',
    color: String(parsed.color || 'from-cyan-400 to-blue-500'),
    contextDna,
    contextInputRange: String(parsed.contextInputRange || '32k – 128k tokens'),
    contextOutputRange: String(parsed.contextOutputRange || '2k – 8k tokens'),
    usageContexts: Array.isArray(parsed.usageContexts)
      ? (parsed.usageContexts as RoleUsageContext[])
      : ['workflow', 'decomposition', 'manual'],
    isPublic: options.isPublic,
    isBuiltin: false,
    ownerId: options.ownerId,
    ownerName: options.ownerName,
    forkCount: 0,
    useCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Fork a role into the forker's library as a private draft.
 * Works for built-in seed roles and custom roles alike; the source
 * role's forkCount is credited when it is a persisted custom role.
 */
export async function forkRoleCard(
  roleId: string,
  options?: { ownerId?: string; ownerName?: string }
): Promise<AgentRoleCard | null> {
  await ensureDiskLoaded();
  const ownerId = options?.ownerId || 'usr-local';
  const ownerName = options?.ownerName || 'Swarm User';

  const source = [...SEED_ROLE_CARDS, ...runtimeCustomRoles].find((r) => r.roleId === roleId);
  if (!source) return null;

  const now = new Date().toISOString();
  const fork: AgentRoleCard = {
    ...JSON.parse(JSON.stringify(source)),
    roleId: `${source.roleId}-fork-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 6)}`,
    name: `${source.name} (Fork)`,
    isPublic: false,
    isBuiltin: false,
    ownerId,
    ownerName,
    forkCount: 0,
    useCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  // Credit the source role with a fork (only custom roles are persisted)
  const src = runtimeCustomRoles.find((r) => r.roleId === roleId);
  if (src) {
    src.forkCount += 1;
    src.updatedAt = now;
  }

  await saveRoleCard(fork);
  return fork;
}

/** Reset in-memory state — for tests only */

export function _resetRoleLibraryForTests(): void {
  runtimeCustomRoles = [];
  diskLoaded = false;
}
