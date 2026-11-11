/**
 * In-process project + task-tree store for the native decomposition engine.
 *
 * State lives in a module-level singleton (kept on `globalThis` so it survives
 * Next.js hot-reloads in dev and is shared across route handlers in a single
 * server instance).
 */

import {
  DeliverableType,
  TaskStatus,
  TaskType,
  type ProjectResponse,
  type TaskNode,
  type TaskTree,
  type TimeBudget,
} from "@/types/decomposition";

export interface ProjectRecord {
  id: string;
  description: string;
  deliverable_type: DeliverableType;
  time_budget_seconds: number;
  status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  tree: TaskTree;
  error?: string | null;
}

interface EngineState {
  projects: Map<string, ProjectRecord>;
}

const globalRef = globalThis as unknown as { __swarmEngine?: EngineState };

function getState(): EngineState {
  if (!globalRef.__swarmEngine) {
    globalRef.__swarmEngine = { projects: new Map() };
  }
  return globalRef.__swarmEngine;
}

const nowIso = () => new Date().toISOString();

/** Build a fully-populated TaskNode from a partial spec. */
export function makeNode(partial: Partial<TaskNode> & { id: string; tree_id: string }): TaskNode {
  return {
    parent_id: null,
    type: TaskType.LEAF,
    status: TaskStatus.PENDING,
    description: "",
    requirements: [],
    acceptance_criteria: [],
    children: [],
    depth: 0,
    path: "",
    assigned_worker_id: null,
    branch_id: null,
    priority: 0,
    estimated_duration: 0,
    actual_duration: null,
    time_budget: 0,
    created_at: nowIso(),
    started_at: null,
    completed_at: null,
    quality_score: null,
    validation_passed: null,
    validation_feedback: "",
    retry_count: 0,
    max_retries: 3,
    last_error: "",
    output: {},
    artifacts: [],
    dependencies: [],
    blocked_by: [],
    metadata: {},
    tags: [],
    ...partial,
  };
}

export function putProject(record: ProjectRecord): void {
  getState().projects.set(record.id, record);
}

export function getProject(id: string): ProjectRecord | undefined {
  return getState().projects.get(id);
}

export function deleteProject(id: string): boolean {
  return getState().projects.delete(id);
}

export function listProjects(): ProjectRecord[] {
  return Array.from(getState().projects.values()).sort((a, b) =>
    b.created_at.localeCompare(a.created_at)
  );
}

/** Recompute derived tree counters (called after any node mutation). */
export function recomputeTree(tree: TaskTree): void {
  const nodes = Object.values(tree.nodes);
  tree.total_nodes = nodes.length;
  tree.completed_nodes = nodes.filter((n) => n.status === TaskStatus.COMPLETED).length;
  tree.failed_nodes = nodes.filter((n) => n.status === TaskStatus.FAILED).length;
  tree.time_consumed = nodes.reduce((sum, n) => sum + (n.actual_duration || 0), 0);
  tree.metadata = {
    ...tree.metadata,
    progress_percent: nodes.length ? (tree.completed_nodes / nodes.length) * 100 : 0,
  };
}

export function toProjectResponse(record: ProjectRecord): ProjectResponse {
  const tree = record.tree;
  recomputeTree(tree);
  const progress = tree.total_nodes ? (tree.completed_nodes / tree.total_nodes) * 100 : 0;
  return {
    project_id: record.id,
    tree_id: tree.id,
    description: record.description,
    deliverable_type: record.deliverable_type,
    status: record.status,
    total_nodes: tree.total_nodes,
    completed_nodes: tree.completed_nodes,
    failed_nodes: tree.failed_nodes,
    progress_percent: progress,
    time_budget: record.time_budget_seconds,
    time_consumed: tree.time_consumed,
    time_remaining: Math.max(0, record.time_budget_seconds - tree.time_consumed),
    created_at: record.created_at,
    started_at: record.started_at,
    completed_at: record.completed_at,
    metadata: tree.metadata || {},
  };
}

export function toTimeBudget(record: ProjectRecord): TimeBudget {
  const tree = record.tree;
  recomputeTree(tree);
  const nodeAllocations: Record<string, number> = {};
  const nodeConsumed: Record<string, number> = {};
  for (const node of Object.values(tree.nodes)) {
    nodeAllocations[node.id] = node.time_budget || 0;
    nodeConsumed[node.id] = node.actual_duration || 0;
  }
  const total = record.time_budget_seconds;
  const consumed = tree.time_consumed;
  const ratio = total > 0 ? consumed / total : 0;
  return {
    tree_id: tree.id,
    total_seconds: total,
    node_allocations: nodeAllocations,
    node_consumed: nodeConsumed,
    total_consumed: consumed,
    total_remaining: Math.max(0, total - consumed),
    warning_threshold: 0.8,
    critical_threshold: 0.95,
    is_exceeded: consumed > total,
    is_warning: ratio >= 0.8 && ratio < 0.95,
    is_critical: ratio >= 0.95,
    created_at: record.created_at,
    last_updated_at: nowIso(),
  };
}
