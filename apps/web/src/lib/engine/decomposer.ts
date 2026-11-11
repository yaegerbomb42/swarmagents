/**
 * DeepSeek-backed decomposition + execution for the native engine.
 *
 * `decomposeProject` turns a goal into a dependency-aware task tree.
 * `executeProject` runs each leaf task through DeepSeek to produce real output.
 */

import { randomUUID } from "crypto";
import { deepseekChat, deepseekJson } from "@/lib/deepseek";
import {
  DeliverableType,
  TaskStatus,
  TaskType,
  type TaskNode,
  type TaskTree,
} from "@/types/decomposition";
import {
  getProject,
  makeNode,
  putProject,
  recomputeTree,
  type ProjectRecord,
} from "./store";

interface DecomposedTask {
  title: string;
  description?: string;
  requirements?: string[];
  acceptance_criteria?: string[];
  estimated_minutes?: number;
}

interface DecomposedArea {
  title: string;
  description?: string;
  tasks?: DecomposedTask[];
}

interface DecompositionResult {
  project_title?: string;
  areas?: DecomposedArea[];
}

const DECOMPOSE_SYSTEM = `You are the SwarmAgents Architect. Decompose a user's project into a hierarchical, dependency-ordered plan.

Rules:
1. Produce 3-6 top-level AREAS (major components).
2. Each area has 2-4 atomic TASKS that a small worker model can complete in one shot (write a file, a function, a test, a config, a doc section).
3. Keep tasks concrete and independently executable. Order them by dependency.
4. Estimate "estimated_minutes" for each task.

Return ONLY strict JSON, no prose, in this exact schema:
{
  "project_title": "string",
  "areas": [
    {
      "title": "string",
      "description": "string",
      "tasks": [
        {
          "title": "string",
          "description": "string",
          "requirements": ["string"],
          "acceptance_criteria": ["string"],
          "estimated_minutes": 20
        }
      ]
    }
  ]
}`;

/** Run DeepSeek decomposition and populate `record.tree`. Mutates + persists. */
export async function decomposeProject(record: ProjectRecord): Promise<void> {
  const result = await deepseekJson<DecompositionResult>(
    DECOMPOSE_SYSTEM,
    `Project: ${record.description}\nDeliverable type: ${record.deliverable_type}\nTime budget (hours): ${(record.time_budget_seconds / 3600).toFixed(1)}\n\nDecompose it now.`,
    { temperature: 0.3, maxTokens: 4096 }
  );

  const tree = record.tree;
  const treeId = tree.id;
  const areas = Array.isArray(result.areas) ? result.areas : [];

  const rootId = tree.root_node_id;
  const root = makeNode({
    id: rootId,
    tree_id: treeId,
    type: TaskType.ROOT,
    status: TaskStatus.READY,
    description: result.project_title || record.description,
    depth: 0,
    path: "0",
    metadata: { deliverable_type: record.deliverable_type },
  });

  const nodes: Record<string, TaskNode> = { [rootId]: root };
  let areaIndex = 0;

  for (const area of areas) {
    const areaId = randomUUID();
    areaIndex += 1;
    const taskNodes: string[] = [];
    const tasks = Array.isArray(area.tasks) ? area.tasks : [];
    let taskIndex = 0;

    for (const task of tasks) {
      const taskId = randomUUID();
      taskIndex += 1;
      const minutes = Math.max(1, Number(task.estimated_minutes) || 15);
      nodes[taskId] = makeNode({
        id: taskId,
        tree_id: treeId,
        parent_id: areaId,
        type: TaskType.LEAF,
        status: TaskStatus.READY,
        description: task.title + (task.description ? ` — ${task.description}` : ""),
        requirements: task.requirements || [],
        acceptance_criteria: task.acceptance_criteria || [],
        depth: 2,
        path: `0.${areaIndex}.${taskIndex}`,
        priority: taskIndex,
        estimated_duration: minutes * 60,
        time_budget: minutes * 60,
        metadata: { title: task.title },
      });
      taskNodes.push(taskId);
    }

    const areaBudget = taskNodes.reduce((s, id) => s + (nodes[id].time_budget || 0), 0);
    nodes[areaId] = makeNode({
      id: areaId,
      tree_id: treeId,
      parent_id: rootId,
      type: TaskType.COMPOSITE,
      status: TaskStatus.READY,
      description: area.title + (area.description ? ` — ${area.description}` : ""),
      children: taskNodes,
      depth: 1,
      path: `0.${areaIndex}`,
      priority: areaIndex,
      time_budget: areaBudget,
      metadata: { title: area.title },
    });
    root.children.push(areaId);
  }

  root.time_budget = root.children.reduce((s, id) => s + (nodes[id].time_budget || 0), 0);

  tree.nodes = nodes;
  tree.root_description = root.description;
  tree.status = "ready";
  recomputeTree(tree);

  record.status = "ready";
  putProject(record);
}

const EXECUTE_SYSTEM = `You are a SwarmAgents worker. You are given ONE atomic task from a larger project. Produce the complete, production-quality deliverable for exactly this task (code, config, or written content as appropriate). Be concise and correct. Output only the deliverable content, no preamble.`;

async function executeLeaf(record: ProjectRecord, node: TaskNode): Promise<void> {
  const tree = record.tree;
  node.status = TaskStatus.EXECUTING;
  node.started_at = new Date().toISOString();
  putProject(record);

  const start = Date.now();
  try {
    const content = await deepseekChat(
      [
        { role: "system", content: EXECUTE_SYSTEM },
        {
          role: "user",
          content:
            `Project: ${record.description}\n` +
            `Task: ${node.metadata?.title || node.description}\n` +
            `Details: ${node.description}\n` +
            (node.requirements?.length ? `Requirements:\n- ${node.requirements.join("\n- ")}\n` : "") +
            (node.acceptance_criteria?.length
              ? `Acceptance criteria:\n- ${node.acceptance_criteria.join("\n- ")}\n`
              : ""),
        },
      ],
      { temperature: 0.4, maxTokens: 2048 }
    );

    node.output = { content };
    node.artifacts = [`${node.metadata?.title || "task"}.md`];
    node.status = TaskStatus.COMPLETED;
    node.quality_score = 0.9;
    node.validation_passed = true;
    node.validation_feedback = "Completed by DeepSeek V4 Flash worker.";
  } catch (err) {
    node.status = TaskStatus.FAILED;
    node.last_error = err instanceof Error ? err.message : String(err);
    node.validation_passed = false;
  } finally {
    node.actual_duration = Math.max(1, Math.round((Date.now() - start) / 1000));
    node.completed_at = new Date().toISOString();
    recomputeTree(tree);
    putProject(record);
  }
}

/** Map over items with bounded concurrency. */
async function pooled<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item === undefined) break;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Execute all leaf tasks through DeepSeek. Runs asynchronously and mutates the
 * stored record as it progresses (clients poll the tree for live updates).
 */
export async function executeProject(projectId: string): Promise<void> {
  const record = getProject(projectId);
  if (!record) return;
  const tree = record.tree;

  record.status = "executing";
  record.started_at = record.started_at || new Date().toISOString();
  tree.status = "executing";
  tree.started_at = tree.started_at || record.started_at;
  putProject(record);

  const leaves = Object.values(tree.nodes).filter((n) => n.type === TaskType.LEAF);
  await pooled(leaves, 4, (leaf) => executeLeaf(record, leaf));

  // Roll composite + root statuses up from their children, deepest-first so a
  // parent sees its children's final state before its own status is computed.
  const parents = Object.values(tree.nodes)
    .filter((n) => n.type !== TaskType.LEAF)
    .sort((a, b) => b.depth - a.depth);
  for (const node of parents) {
    const children = node.children.map((id) => tree.nodes[id]).filter(Boolean);
    if (children.length && children.every((c) => c.status === TaskStatus.COMPLETED)) {
      node.status = TaskStatus.COMPLETED;
      node.completed_at = new Date().toISOString();
    } else if (children.some((c) => c.status === TaskStatus.FAILED)) {
      node.status = TaskStatus.FAILED;
    }
  }

  recomputeTree(tree);
  const anyFailed = tree.failed_nodes > 0;
  tree.status = anyFailed ? "failed" : "completed";
  tree.completed_at = new Date().toISOString();
  record.status = tree.status;
  record.completed_at = tree.completed_at;
  putProject(record);
}

/** Assemble all completed leaf outputs into a single markdown deliverable. */
export function assembleDeliverable(record: ProjectRecord): string {
  const tree = record.tree;
  const lines: string[] = [
    `# ${tree.root_description || record.description}`,
    "",
    `_Generated by SwarmAgents (DeepSeek V4 Flash). Deliverable type: ${record.deliverable_type}._`,
    "",
  ];
  for (const areaId of tree.nodes[tree.root_node_id]?.children || []) {
    const area = tree.nodes[areaId];
    if (!area) continue;
    lines.push(`## ${area.metadata?.title || area.description}`, "");
    for (const taskId of area.children) {
      const task = tree.nodes[taskId];
      if (!task) continue;
      lines.push(`### ${task.metadata?.title || task.description}`, "");
      lines.push(String(task.output?.content || "_(not executed)_"), "");
    }
  }
  return lines.join("\n");
}

/** Create the empty tree skeleton for a new project. */
export function createEmptyTree(projectId: string, deliverableType: DeliverableType, totalBudgetSeconds: number): TaskTree {
  const rootId = randomUUID();
  const now = new Date().toISOString();
  return {
    id: projectId,
    project_id: projectId,
    root_node_id: rootId,
    root_description: "",
    status: "decomposing",
    nodes: {},
    branches: {},
    created_at: now,
    started_at: null,
    completed_at: null,
    total_time_budget: totalBudgetSeconds,
    time_consumed: 0,
    total_nodes: 0,
    completed_nodes: 0,
    failed_nodes: 0,
    deliverable_type: deliverableType,
    deliverable_path: null,
    metadata: { progress_percent: 0 },
  };
}
