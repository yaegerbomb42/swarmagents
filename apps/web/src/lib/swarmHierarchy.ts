import { AGENT_ROLES } from '@/lib/agentRoles';
import type { RoleBinding } from '@/lib/roleBindings';
import type { StoredProvider } from '@/lib/providerStore';
import type { AgentSandbox, SandboxAction, SandboxStatus } from '@/lib/sandboxTypes';

export type SwarmActivity = 'idle' | 'working' | 'communicating';

export interface HierarchyAgent {
  id: string;
  roleId: string;
  parentId: string | null;
  status: SandboxStatus;
  label: string;
  assignedModel?: string;
  providerName?: string;
  activity: SwarmActivity;
  live: boolean;
}

const CORE_ROLE_IDS = ['architect', 'implementer', 'verifier', 'researcher', 'debugger', 'planner'];

export function resolveRoleId(hint: string | undefined): string {
  if (!hint) return 'implementer';
  const h = hint.toLowerCase().trim();
  const exact = AGENT_ROLES.find((r) => r.id === h || r.name.toLowerCase() === h);
  if (exact) return exact.id;
  for (const role of AGENT_ROLES) {
    const name = role.name.toLowerCase();
    if (h.includes(role.id) || h.includes(name)) return role.id;
  }
  return 'implementer';
}

function actionTimestamp(action: SandboxAction): number {
  if (typeof action.ts === 'number' && action.ts > 1_000_000_000_000) return action.ts;
  return Date.now();
}

export function detectSandboxActivity(sb: AgentSandbox): SwarmActivity {
  const now = Date.now();
  const recent = (sb.actionLog || []).filter((a) => now - actionTimestamp(a) < 20_000);
  const communicating = recent.some(
    (a) =>
      a.type === 'communicate' &&
      (a.status === 'running' || now - actionTimestamp(a) < 8_000),
  );
  if (communicating) return 'communicating';
  if (sb.status === 'running') return 'working';
  if (recent.some((a) => a.status === 'running')) return 'working';
  return 'idle';
}

function modelLabel(binding: RoleBinding, providers: StoredProvider[]): { model: string; providerName: string } {
  const opt = binding.options[0];
  const provider = providers.find((p) => p.id === opt?.providerId);
  return {
    model: opt?.model || provider?.models?.[0] || 'default',
    providerName: provider?.name || opt?.providerId || 'provider',
  };
}

export interface OrgSeat {
  id: string;
  title: string;
  status: string;
  ownsPaths?: string[];
  leafIds?: string[];
}

export function mergeOrgSeats(agents: HierarchyAgent[], seats: OrgSeat[]): HierarchyAgent[] {
  if (!seats.length) return agents;

  const byId = new Map(agents.map((a) => [a.id, { ...a }]));
  const defaultParent = agents.find((a) => a.roleId === 'architect' && !a.parentId)?.id
    ?? agents.find((a) => !a.parentId)?.id
    ?? null;

  for (const seat of seats) {
    if (seat.status === 'retired') continue;
    const running = seat.status === 'running' || seat.status === 'active';
    const existing = byId.get(seat.id);
    if (existing) {
      byId.set(seat.id, {
        ...existing,
        label: seat.title || existing.label,
        live: running || existing.live,
        activity: running ? 'working' : existing.activity,
        status: running ? 'running' : existing.status,
      });
      continue;
    }

    byId.set(seat.id, {
      id: seat.id,
      roleId: 'implementer',
      parentId: defaultParent,
      status: running ? 'running' : 'idle',
      label: seat.title || seat.id,
      activity: running ? 'working' : 'idle',
      live: true,
    });
  }

  return Array.from(byId.values());
}

export function buildSwarmHierarchy(
  bindings: RoleBinding[],
  providers: StoredProvider[],
  sandboxes: AgentSandbox[],
): HierarchyAgent[] {
  const configured = bindings.filter((b) => b.options?.length);
  const seedBindings =
    configured.length > 0
      ? configured
      : CORE_ROLE_IDS.map((roleId) => ({ roleId, mode: 'auto' as const, options: [] }));

  const agents = new Map<string, HierarchyAgent>();
  const sandboxIds = new Set(sandboxes.map((s) => s.id));

  for (const binding of seedBindings) {
    const role = AGENT_ROLES.find((r) => r.id === binding.roleId);
    if (!role) continue;
    const { model, providerName } =
      binding.options.length > 0
        ? modelLabel(binding, providers)
        : { model: 'unassigned', providerName: 'settings' };
    const id = `role:${binding.roleId}`;
    agents.set(id, {
      id,
      roleId: binding.roleId,
      parentId: null,
      status: 'idle',
      label: role.name,
      assignedModel: model,
      providerName,
      activity: 'idle',
      live: false,
    });
  }

  const roleRootFor = (roleId: string): string => `role:${roleId}`;

  const resolveParentId = (sb: AgentSandbox, roleId: string): string | null => {
    if (sb.parentId) {
      if (agents.has(sb.parentId) || sandboxIds.has(sb.parentId)) return sb.parentId;
      const rootId = roleRootFor(roleId);
      return agents.has(rootId) ? rootId : sb.parentId;
    }
    return agents.has(roleRootFor(roleId)) ? roleRootFor(roleId) : null;
  };

  for (const sb of sandboxes) {
    const roleId = resolveRoleId(sb.archetype || sb.agentClass || sb.label);
    const activity = detectSandboxActivity(sb);
    const rootId = roleRootFor(roleId);

    if (!sb.parentId && agents.has(rootId)) {
      const root = agents.get(rootId)!;
      agents.set(rootId, {
        ...root,
        status: sb.status,
        activity,
        live: true,
        assignedModel: sb.model || root.assignedModel,
      });
      continue;
    }

    const parentId = sb.parentId ? resolveParentId(sb, roleId) : agents.has(rootId) ? rootId : null;

    agents.set(sb.id, {
      id: sb.id,
      roleId,
      parentId,
      status: sb.status,
      label: sb.taskLabel || sb.label || roleId,
      assignedModel: sb.model,
      providerName: sb.providerId,
      activity,
      live: true,
    });
  }

  return Array.from(agents.values());
}
