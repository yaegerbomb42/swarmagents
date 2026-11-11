/**
 * Organizer / spawner — keeps the live decomp tree evolving.
 * Applies agent-queued mutations (.swarm/tree_mutations.jsonl) and
 * autonomously spawn / skip / deepen / merge to hit timelines.
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { DecompSessionRecord } from '@/lib/decompSessions';
import { ensureSeats, getSeats } from '@/lib/seatSpawner';

export type TreeMutationOp = 'spawn' | 'skip' | 'deepen' | 'merge';

export type TreeMutation = {
  op: TreeMutationOp;
  at?: number;
  source?: string;
  label?: string;
  description?: string;
  parent_id?: string | null;
  node_id?: string;
  keep_id?: string;
  absorb_id?: string;
  effort_minutes?: number;
  hint?: string;
  reason?: string;
};

export type OrganizerEvent = {
  at: number;
  level: 'info' | 'action' | 'warn';
  message: string;
  op?: TreeMutationOp | 'assign' | 'pace';
};

export type OrganizerTickResult = {
  applied: number;
  events: OrganizerEvent[];
  spawned: string[];
  skipped: string[];
  deepened: string[];
  merged: string[];
};

function collectLeaves(nodes: any[]): any[] {
  const leaves: any[] = [];
  const walk = (list: any[]) => {
    for (const n of list || []) {
      const kids = n.children || [];
      if (!kids.length && (n.type === 'task' || n.type === 'leaf' || !n.type)) leaves.push(n);
      else if (kids.length) walk(kids);
      else leaves.push(n);
    }
  };
  walk(nodes || []);
  return leaves;
}

function findNode(nodes: any[], id: string): any | null {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    const hit = findNode(n.children || [], id);
    if (hit) return hit;
  }
  return null;
}

function locateParent(nodes: any[], childId: string): { parent: any | null; list: any[] } | null {
  const walk = (list: any[], parent: any | null): { parent: any | null; list: any[] } | null => {
    for (const n of list || []) {
      if (n.id === childId) return { parent, list };
      const kids = n.children || [];
      if (kids.length) {
        const hit = walk(kids, n);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(nodes, null);
}

function budgetSec(session: DecompSessionRecord): number {
  return Math.max(60, (Number(session.budget_minutes) || 60) * 60);
}

function elapsedSec(session: DecompSessionRecord): number {
  return Math.max(0, (Date.now() - (session.createdAt || Date.now())) / 1000);
}

async function readMutations(workspace: string): Promise<TreeMutation[]> {
  const file = path.join(workspace, '.swarm', 'tree_mutations.jsonl');
  try {
    const raw = await fs.readFile(file, 'utf8');
    const rows: TreeMutation[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as TreeMutation);
      } catch {
        /* skip */
      }
    }
    return rows;
  } catch {
    return [];
  }
}

async function clearMutations(workspace: string): Promise<void> {
  const swarm = path.join(workspace, '.swarm');
  try {
    await fs.mkdir(swarm, { recursive: true });
    await fs.writeFile(path.join(swarm, 'tree_mutations.jsonl'), '', 'utf8');
  } catch {
    /* ignore */
  }
}

function applySpawn(session: DecompSessionRecord, m: TreeMutation, events: OrganizerEvent[]): string | null {
  const label = String(m.label || 'Spawned leaf').slice(0, 200);
  const parent =
    (m.parent_id && findNode(session.nodes, m.parent_id)) ||
    session.nodes[0] ||
    null;
  if (!parent) return null;
  const leaf = {
    id: `${parent.id}-sp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'task',
    label,
    description: String(m.description || label),
    acceptance_criteria: [`Done when: ${label}`],
    priority: 'high',
    effort_minutes: Number(m.effort_minutes) || 5,
    needs_deeper: false,
    depends_on: [] as string[],
    status: 'pending',
    runCount: 0,
    parentId: parent.id,
    depth: (parent.depth || 0) + 1,
    children: [] as any[],
    spawned_by: m.source || 'organizer',
  };
  parent.children = parent.children || [];
  parent.children.push(leaf);
  if (parent.type === 'task') parent.type = 'area';
  events.push({
    at: Date.now(),
    level: 'action',
    op: 'spawn',
    message: `Organizer spawned “${label}” under ${parent.label || parent.id}`,
  });
  return leaf.id;
}

function applySkip(session: DecompSessionRecord, m: TreeMutation, events: OrganizerEvent[]): string | null {
  const id = String(m.node_id || '');
  const node = findNode(session.nodes, id);
  if (!node) return null;
  if (node.children?.length) return null;
  node.status = 'failed';
  node.skipped = true;
  node.result = `Skipped by organizer: ${m.reason || 'obsolete'}`;
  events.push({
    at: Date.now(),
    level: 'action',
    op: 'skip',
    message: `Organizer skipped “${node.label || id}”`,
  });
  return id;
}

function applyDeepen(session: DecompSessionRecord, m: TreeMutation, events: OrganizerEvent[]): string | null {
  const id = String(m.node_id || '');
  const node = findNode(session.nodes, id);
  if (!node) return null;
  const hint = String(m.hint || m.reason || node.label || 'subtask').slice(0, 120);
  const parts = [
    `Scope: ${hint}`,
    `Implement core of: ${node.label || id}`,
    `Verify / tests for: ${node.label || id}`,
  ];
  node.children = node.children || [];
  const ids: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const child = {
      id: `${node.id}-d${i}-${Date.now().toString(36).slice(-4)}`,
      type: 'task',
      label: parts[i].slice(0, 160),
      description: parts[i],
      acceptance_criteria: [`Done when: ${parts[i]}`],
      priority: node.priority || 'medium',
      effort_minutes: Math.max(3, Math.floor((Number(node.effort_minutes) || 15) / 3)),
      needs_deeper: false,
      depends_on: i > 0 ? [`${node.id}-d${i - 1}-${Date.now().toString(36).slice(-4)}`] : [],
      status: 'pending',
      runCount: 0,
      parentId: node.id,
      depth: (node.depth || 0) + 1,
      children: [] as any[],
      deepened_from: node.id,
    };
    // Fix depends_on to actual previous id
    if (i > 0) child.depends_on = [ids[i - 1]];
    node.children.push(child);
    ids.push(child.id);
  }
  node.type = 'area';
  node.needs_deeper = false;
  node.status = 'pending';
  events.push({
    at: Date.now(),
    level: 'action',
    op: 'deepen',
    message: `Organizer deepened “${node.label || id}” → ${ids.length} leaves`,
  });
  return id;
}

function applyMerge(session: DecompSessionRecord, m: TreeMutation, events: OrganizerEvent[]): string | null {
  const keepId = String(m.keep_id || '');
  const absorbId = String(m.absorb_id || '');
  if (!keepId || !absorbId || keepId === absorbId) return null;
  const keep = findNode(session.nodes, keepId);
  const absorb = findNode(session.nodes, absorbId);
  if (!keep || !absorb) return null;
  keep.description = `${keep.description || keep.label}\n\nMerged: ${absorb.label || absorbId}\n${absorb.description || ''}`.slice(
    0,
    4000
  );
  keep.effort_minutes =
    (Number(keep.effort_minutes) || 5) + (Number(absorb.effort_minutes) || 5);
  const loc = locateParent(session.nodes, absorbId);
  if (loc) {
    loc.list.splice(
      loc.list.findIndex((n) => n.id === absorbId),
      1
    );
  }
  absorb.status = 'failed';
  absorb.merged_into = keepId;
  events.push({
    at: Date.now(),
    level: 'action',
    op: 'merge',
    message: `Organizer merged “${absorb.label || absorbId}” → “${keep.label || keepId}”`,
  });
  return keepId;
}

function applyMutation(
  session: DecompSessionRecord,
  m: TreeMutation,
  events: OrganizerEvent[],
  buckets: OrganizerTickResult
): void {
  switch (m.op) {
    case 'spawn': {
      const id = applySpawn(session, m, events);
      if (id) {
        buckets.spawned.push(id);
        buckets.applied += 1;
      }
      break;
    }
    case 'skip': {
      const id = applySkip(session, m, events);
      if (id) {
        buckets.skipped.push(id);
        buckets.applied += 1;
      }
      break;
    }
    case 'deepen': {
      const id = applyDeepen(session, m, events);
      if (id) {
        buckets.deepened.push(id);
        buckets.applied += 1;
      }
      break;
    }
    case 'merge': {
      const id = applyMerge(session, m, events);
      if (id) {
        buckets.merged.push(id);
        buckets.applied += 1;
      }
      break;
    }
    default:
      break;
  }
}

/** Heuristic: deepen oversized pending leaves; spawn if queue empty while time remains. */
function autonomousPace(session: DecompSessionRecord, events: OrganizerEvent[], buckets: OrganizerTickResult) {
  const leaves = collectLeaves(session.nodes);
  const pending = leaves.filter((n) => !['completed', 'failed'].includes(String(n.status)));
  const remaining = Math.max(0, budgetSec(session) - elapsedSec(session));
  const fractionLeft = remaining / budgetSec(session);

  // Deepen stuck large leaves (high effort, no progress)
  for (const leaf of pending.slice(0, 8)) {
    const effort = Number(leaf.effort_minutes) || 0;
    const runs = Number(leaf.runCount) || 0;
    const continues = Number(leaf.continue_count) || 0;
    if ((effort >= 25 || continues >= 6) && runs >= 1 && !leaf._organizer_deepened) {
      leaf._organizer_deepened = true;
      applyMutation(
        session,
        {
          op: 'deepen',
          node_id: leaf.id,
          hint: String(leaf.label || ''),
          reason: 'organizer: leaf too large / stuck',
          source: 'organizer',
        },
        events,
        buckets
      );
    }
  }

  // Merge near-duplicate pending labels
  const pendingFresh = collectLeaves(session.nodes).filter(
    (n) => !['completed', 'failed'].includes(String(n.status))
  );
  const seen = new Map<string, any>();
  for (const leaf of pendingFresh) {
    const key = String(leaf.label || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .slice(0, 48);
    if (!key) continue;
    const prev = seen.get(key);
    if (prev) {
      applyMutation(
        session,
        {
          op: 'merge',
          keep_id: prev.id,
          absorb_id: leaf.id,
          reason: 'organizer: duplicate label',
          source: 'organizer',
        },
        events,
        buckets
      );
    } else {
      seen.set(key, leaf);
    }
  }

  // If almost no pending work but time remains, spawn a ship/checkpoint leaf
  const stillPending = collectLeaves(session.nodes).filter(
    (n) => !['completed', 'failed'].includes(String(n.status))
  );
  if (stillPending.length === 0 && fractionLeft > 0.15 && session.status !== 'completed') {
    applyMutation(
      session,
      {
        op: 'spawn',
        label: 'Ship checkpoint — verify deliverables and fill gaps',
        description:
          'Organizer: time remains with empty queue. Audit workspace, fix gaps, write missing pieces.',
        effort_minutes: 10,
        reason: 'organizer: keep building',
        source: 'organizer',
      },
      events,
      buckets
    );
  } else if (stillPending.length < 2 && fractionLeft > 0.35) {
    applyMutation(
      session,
      {
        op: 'spawn',
        label: 'Polish & integration pass',
        description: 'Wire pieces together, fix broken imports, add a short README if missing.',
        effort_minutes: 8,
        reason: 'organizer: backlog thin',
        source: 'organizer',
      },
      events,
      buckets
    );
  }

  // Ensure seats cover pending leaves
  ensureSeats(session, { hotspots: [], blackboardHints: [] });
  const seats = getSeats(session);
  events.push({
    at: Date.now(),
    level: 'info',
    op: 'assign',
    message: `Organizer: ${stillPending.length} pending · ${seats.filter((s) => s.status !== 'retired').length} agents · ${Math.round(remaining)}s left`,
  });
}

/**
 * Drain agent mutations, then organizer pace/assignment.
 */
export async function tickOrganizer(
  session: DecompSessionRecord,
  workspace: string
): Promise<OrganizerTickResult> {
  const events: OrganizerEvent[] = [];
  const result: OrganizerTickResult = {
    applied: 0,
    events,
    spawned: [],
    skipped: [],
    deepened: [],
    merged: [],
  };

  const queued = await readMutations(workspace);
  for (const m of queued) {
    if (!m?.op) continue;
    applyMutation(session, m, events, result);
  }
  if (queued.length) await clearMutations(workspace);

  autonomousPace(session, events, result);

  session.organizer = {
    role: 'organizer',
    lastTickAt: Date.now(),
    events: events.slice(-40),
    applied: result.applied,
    spawned: result.spawned.length,
    skipped: result.skipped.length,
    deepened: result.deepened.length,
    merged: result.merged.length,
  };

  return result;
}
