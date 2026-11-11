/**
 * Week 3 — session-scoped world model.
 * Ground truth after gate pass only. Lives at workspace/.swarm/world_graph.json
 * (same schema as engine WorldModelGraph for interoperability).
 */
import { promises as fs } from 'fs';
import path from 'path';
import type { DecompSessionRecord } from '@/lib/decompSessions';
import type { LeafValidationReport } from '@/lib/leafCompletionGates';

export type WorldNode = {
  id: string;
  type: string;
  metadata: Record<string, unknown>;
  confidence: number;
  created_at: string;
  updated_at: string;
};

export type WorldEdge = {
  source: string;
  target: string;
  relation: string;
  confidence: number;
  created_at: string;
};

export type SessionWorldModel = {
  nodes: Record<string, WorldNode>;
  edges: WorldEdge[];
};

function graphPath(workspace: string): string {
  return path.join(workspace, '.swarm', 'world_graph.json');
}

function nowIso(): string {
  return new Date().toISOString();
}

export function emptyWorldModel(): SessionWorldModel {
  return { nodes: {}, edges: [] };
}

export async function loadSessionWorldModel(workspace: string): Promise<SessionWorldModel> {
  try {
    const raw = await fs.readFile(graphPath(workspace), 'utf8');
    const parsed = JSON.parse(raw) as SessionWorldModel;
    if (parsed && typeof parsed.nodes === 'object' && Array.isArray(parsed.edges)) {
      return parsed;
    }
  } catch {
    /* new */
  }
  return emptyWorldModel();
}

export async function saveSessionWorldModel(
  workspace: string,
  graph: SessionWorldModel
): Promise<void> {
  await fs.mkdir(path.join(workspace, '.swarm'), { recursive: true });
  await fs.writeFile(graphPath(workspace), JSON.stringify(graph, null, 2), 'utf8');
}

function upsertNode(
  graph: SessionWorldModel,
  id: string,
  type: string,
  metadata: Record<string, unknown>,
  confidence = 1
): void {
  const t = nowIso();
  const existing = graph.nodes[id];
  if (existing) {
    existing.metadata = { ...existing.metadata, ...metadata };
    existing.confidence = confidence;
    existing.updated_at = t;
    existing.type = type || existing.type;
  } else {
    graph.nodes[id] = {
      id,
      type,
      metadata,
      confidence,
      created_at: t,
      updated_at: t,
    };
  }
}

function upsertEdge(
  graph: SessionWorldModel,
  source: string,
  target: string,
  relation: string,
  confidence = 1
): void {
  const hit = graph.edges.find(
    (e) => e.source === source && e.target === target && e.relation === relation
  );
  if (hit) {
    hit.confidence = confidence;
    return;
  }
  graph.edges.push({
    source,
    target,
    relation,
    confidence,
    created_at: nowIso(),
  });
}

/**
 * Record a gate-validated leaf as ground truth. Call ONLY after validation_passed.
 */
export async function recordLeafValidated(
  workspace: string,
  session: DecompSessionRecord,
  node: any,
  report: LeafValidationReport
): Promise<SessionWorldModel> {
  const graph = await loadSessionWorldModel(workspace);
  const sessionId = session.id || 'session';
  const leafId = `leaf:${node.id}`;
  const goalId = `goal:${sessionId}`;

  upsertNode(
    graph,
    goalId,
    'goal',
    {
      description: String(
        (session as { goal?: string }).goal ||
          session.project ||
          (session.summary as { goal?: string } | undefined)?.goal ||
          sessionId
      ).slice(0, 800),
      sessionId,
    },
    1
  );

  const files = (Array.isArray(node.files_written) ? node.files_written : [])
    .map((f: string) => String(f || '').replace(/^\.\//, ''))
    .filter((f: string) => f && !f.includes('.swarm/') && !f.includes('..'));

  upsertNode(
    graph,
    leafId,
    'leaf',
    {
      label: String(node.label || node.id),
      description: String(node.description || '').slice(0, 600),
      status: 'validated',
      validation_passed: true,
      qualityBar: report.qualityBar,
      hardFailures: [],
      gatesPassed: report.gates.filter((g) => g.status === 'passed').map((g) => g.id),
      receiptPath: report.receiptPath,
      artifacts: files.slice(0, 40),
      validatedAt: report.completedAt,
    },
    1
  );
  upsertEdge(graph, goalId, leafId, 'implements', 1);

  if (node.parentId) {
    const parentId = `leaf:${node.parentId}`;
    upsertNode(graph, parentId, 'leaf', { id: node.parentId }, 0.8);
    upsertEdge(graph, parentId, leafId, 'depends-on', 1);
  }

  for (const rel of files.slice(0, 40)) {
    const fileId = `file:${rel}`;
    upsertNode(
      graph,
      fileId,
      'file',
      {
        path: rel,
        producedBy: node.id,
        validated: true,
      },
      1
    );
    upsertEdge(graph, leafId, fileId, 'creates', 1);
    upsertEdge(graph, fileId, leafId, 'created-by', 1);
  }

  const decisionId = `decision:gate:${node.id}:${report.completedAt}`;
  upsertNode(
    graph,
    decisionId,
    'decision',
    {
      topic: `gate_pass:${node.id}`,
      summary: `Leaf “${node.label || node.id}” passed ${report.qualityBar} gates`,
      gates: report.gates.map((g) => ({ id: g.id, status: g.status, hard: g.hard })),
    },
    1
  );
  upsertEdge(graph, leafId, decisionId, 'caused-by', 1);

  // Cap growth
  const nodeIds = Object.keys(graph.nodes);
  if (nodeIds.length > 2000) {
    const drop = nodeIds.slice(0, nodeIds.length - 1800);
    for (const id of drop) delete graph.nodes[id];
    graph.edges = graph.edges.filter((e) => graph.nodes[e.source] && graph.nodes[e.target]);
  }
  if (graph.edges.length > 4000) {
    graph.edges = graph.edges.slice(-3500);
  }

  await saveSessionWorldModel(workspace, graph);

  // Attach snapshot on session for API consumers
  (session as { worldModel?: { nodeCount: number; edgeCount: number; updatedAt: number } }).worldModel =
    {
      nodeCount: Object.keys(graph.nodes).length,
      edgeCount: graph.edges.length,
      updatedAt: Date.now(),
    };

  return graph;
}

/** Compact ground-truth brief for the next leaf agent. */
export function formatWorldModelForPrompt(
  graph: SessionWorldModel,
  opts?: { limit?: number; focusLeafId?: string }
): string {
  const limit = opts?.limit ?? 12;
  const validated = Object.values(graph.nodes)
    .filter((n) => n.type === 'leaf' && n.metadata?.validation_passed === true)
    .sort(
      (a, b) =>
        Number(b.metadata?.validatedAt || 0) - Number(a.metadata?.validatedAt || 0)
    )
    .slice(0, limit);

  if (!validated.length) return '';

  const files = Object.values(graph.nodes)
    .filter((n) => n.type === 'file' && n.metadata?.validated)
    .slice(0, 20)
    .map((n) => String(n.metadata.path || n.id.replace(/^file:/, '')));

  const lines = [
    'WORLD MODEL (verified ground truth — do not contradict; extend it):',
    ...validated.map((n) => {
      const arts = Array.isArray(n.metadata.artifacts)
        ? (n.metadata.artifacts as string[]).slice(0, 4).join(', ')
        : '';
      return `- ✓ ${n.metadata.label || n.id}${arts ? ` → ${arts}` : ''}`;
    }),
  ];
  if (files.length) {
    lines.push(`Verified files: ${files.slice(0, 12).join(', ')}`);
  }
  return lines.join('\n');
}

export async function worldModelPromptSlice(workspace: string): Promise<string> {
  const graph = await loadSessionWorldModel(workspace);
  return formatWorldModelForPrompt(graph);
}
