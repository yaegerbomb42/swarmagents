import { NextRequest, NextResponse } from 'next/server';
import { getSession, findNode } from '@/lib/decompSessions';
import type { AgentSandbox, SandboxGridSnapshot, SandboxMode, SandboxLogLine } from '@/lib/sandboxTypes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8400';
const MAX_VISIBLE = 20;
const CANVAS_W = 800;
const CANVAS_H = 420;

/** Deterministic canvas coordinates for SwarmCanvas live position sync. */
function computeAgentCanvasPosition(
  index: number,
  total: number,
  status: string,
): { x: number; y: number } {
  const golden = index * 2.399963;
  const spread = 0.35 + (index % 7) * 0.09;
  const r = 0.22 * Math.min(CANVAS_W, CANVAS_H) * spread;
  const cx = CANVAS_W * 0.5;
  const cy = CANVAS_H * 0.5;
  let x = cx + Math.cos(golden) * r;
  let y = cy + Math.sin(golden) * r;
  // Active agents cluster toward mission center; idle agents drift outward.
  const active = status === 'running' || status === 'executing' || status === 'assigned';
  const pull = active ? 0.82 : 1.08 + (index % 3) * 0.04;
  x = cx + (x - cx) * pull;
  y = cy + (y - cy) * pull;
  // Slight vertical bias when multiple agents share the canvas.
  if (total > 1) {
    y += ((index / Math.max(1, total - 1)) - 0.5) * 18;
  }
  return { x: Math.round(x), y: Math.round(y) };
}

function inferMode(tools: string[] = [], agentClass?: string): SandboxMode {
  const t = new Set(tools.map((x) => x.toLowerCase()));
  if (t.has('browser') && (t.has('shell') || t.has('edit'))) return 'mixed';
  if (t.has('browser') || agentClass === 'research') return 'browser';
  if (t.has('edit') && !t.has('shell')) return 'edit';
  return 'shell';
}

function flattenActive(nodes: any[]): any[] {
  const out: any[] = [];
  const walk = (list: any[]) => {
    for (const n of list || []) {
      const status = String(n.status || '');
      const active = ['running', 'executing', 'assigned', 'decomposing', 'paused'].includes(status);
      const isLeaf = !n.children?.length;
      if (active || (isLeaf && status === 'pending' && n.injected)) {
        if (isLeaf || active) out.push(n);
      }
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

function synthLogs(node: any, mode: SandboxMode): SandboxLogLine[] {
  const now = Date.now();
  const logs: SandboxLogLine[] = [];
  const role = String(node.assignedAgent || node.agent_class || 'worker');

  logs.push({ ts: now - 50, kind: 'info', text: `${role} · ${mode} · ${String(node.status || 'pending')}` });

  // Prefer real step history from the leaf runner
  const history = Array.isArray(node.step_history) ? node.step_history : [];
  for (const step of history.slice(-12)) {
    const tool = String(step.tool || step.action || 'step');
    const thought = String(step.thought || step.summary || '').slice(0, 120);
    const ok = step.ok !== false;
    logs.push({
      ts: Number(step.ts) || now - 10,
      kind: tool === 'shell_exec' || tool === 'shell' ? 'stdout' : tool.includes('browser') ? 'nav' : 'tool',
      text: thought ? `${tool}: ${thought}` : `${tool}${ok ? '' : ' · failed'}`,
    });
  }

  const files = Array.isArray(node.files_written) ? node.files_written : [];
  for (const f of files.slice(-6)) {
    logs.push({ ts: now - 5, kind: 'tool', text: `file_write ${f}` });
  }

  if (node.result && String(node.result).length > 8) {
    logs.push({
      ts: now,
      kind: 'info',
      text: String(node.result).replace(/\s+/g, ' ').slice(0, 140),
    });
  }

  return logs.slice(-24);
}

async function fetchBrowserStatus(): Promise<{ online: boolean; url?: string; screenshotUrl?: string; task?: string }> {
  try {
    const r = await fetch(`${ENGINE_URL}/browser/status`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { online: false };
    const j = await r.json();
    return {
      online: j.status === 'running' || j.cdpConnected === true || j.status === 'idle',
      url: j.currentUrl || j.url || j.currentTask,
      screenshotUrl: j.screenshotUrl || j.screenshot,
      task: j.currentTask,
    };
  } catch {
    return { online: false };
  }
}

async function fetchEngineWorkers(): Promise<any[]> {
  try {
    const r = await fetch(`${ENGINE_URL}/telemetry`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return [];
    const j = await r.json();
    return j.workers || j.telemetry?.workers || [];
  } catch {
    return [];
  }
}

function synthActionLog(node: any, mode: SandboxMode): any[] {
  const actions: any[] = [];
  const history = Array.isArray(node.step_history) ? node.step_history : [];
  const now = Date.now();

  if (history.length > 0) {
    history.forEach((step: any, idx: number) => {
      const tool = String(step.tool || step.action || 'think');
      const paramStr = step.args ? String(step.args) : step.summary ? `(${step.summary})` : '()';
      const type = tool.includes('browser')
        ? 'use_browser'
        : tool.includes('spawn')
        ? 'spawn_subagent'
        : tool.includes('communicat')
        ? 'communicate'
        : tool.includes('create')
        ? 'create_file'
        : tool.includes('edit')
        ? 'file_edit'
        : tool.includes('blackboard')
        ? 'check_blackboard'
        : tool.includes('compress')
        ? 'compress_context'
        : tool.includes('commit')
        ? 'git_commit'
        : tool.includes('think')
        ? 'think'
        : 'shell_exec';

      const actionId = `act-${node.id}-${idx}`;
      // Real step timestamp only; unknown timing stays undefined (rendered as "—").
      const ts = Number(step.ts) || Number(step.timestamp) || undefined;

      actions.push({
        id: actionId,
        ts,
        fn: tool,
        args: paramStr,
        type,
        status: step.ok === false ? 'error' : 'done',
        color:
          type === 'use_browser'
            ? '#888'
            : type === 'communicate'
            ? '#00f5ff'
            : type === 'spawn_subagent'
            ? '#a855f7'
            : type === 'create_file' || type === 'file_edit'
            ? '#e5e5e5'
            : type === 'think'
            ? '#facc15'
            : type === 'check_blackboard'
            ? '#666'
            : type === 'compress_context'
            ? '#fb923c'
            : type === 'git_commit'
            ? '#22c55e'
            : '#60a5fa',
        filePath: step.path || node.files_written?.[0],
        diffLines: step.diff || undefined,
      });
    });
  }

  return actions;
}

function findParentId(nodes: any[], targetId: string, parentId: string | null = null): string | null {
  for (const n of nodes || []) {
    if (n.id === targetId) return parentId;
    const found = findParentId(n.children, targetId, n.id);
    if (found !== null) return found;
  }
  return null;
}

function nodeToSandbox(
  node: any,
  browser: { online: boolean; url?: string; screenshotUrl?: string },
  focusId?: string | null,
  parentNodeId?: string | null,
  canvasIndex = 0,
  canvasTotal = 1,
): AgentSandbox {
  const tools = node.tools || ['edit', 'browser', 'shell'];
  const mode = inferMode(tools, node.agent_class);
  const status =
    node.status === 'paused'
      ? 'paused'
      : node.status === 'failed'
        ? 'error'
        : node.status === 'completed'
          ? 'done'
          : ['running', 'executing', 'assigned', 'decomposing', 'validating'].includes(node.status)
            ? 'running'
            : 'idle';

  const roleTitle = String(node.assignedAgent || node.agent_class || node.id);
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : undefined;
  };
  // Only real engine-reported numbers; missing values stay undefined and render as "—".
  const tokensIn = num(node.tokens_in);
  const tokensOut = num(node.tokens_out);
  const contextPct = num(node.context_pct);

  return {
    id: `sbx-${node.id}`,
    agentId: roleTitle,
    nodeId: node.id,
    label: roleTitle,
    mode,
    status,
    agentClass: node.agent_class || undefined,
    archetype: node.agent_class || undefined,
    modelTier: node.model_tier || undefined,
    model: node.model || undefined,
    tools,
    tokensIn,
    tokensOut,
    contextPct,
    url: mode === 'browser' || mode === 'mixed' ? browser.url : undefined,
    screenshotUrl:
      (mode === 'browser' || mode === 'mixed') && browser.screenshotUrl
        ? browser.screenshotUrl
        : undefined,
    cwd: '/workspace',
    logs: synthLogs(node, mode),
    actionLog: synthActionLog(node, mode),
    blackboardEntries: Array.isArray(node.blackboard_entries) ? node.blackboard_entries : undefined,
    thoughtStream: Array.isArray(node.thought_stream) ? node.thought_stream : undefined,
    toolCallCount:
      Number(node.tool_calls) ||
      (Array.isArray(node.step_history) ? node.step_history.length : 0),
    startedAt: num(node.startedAt) ?? num(node.started_at),
    focused: focusId === node.id,
    parentId: parentNodeId ? `sbx-${parentNodeId}` : node.parent_id || node.parentId || null,
    taskLabel: String(node.label || node.description || node.id),
    filesWritten: Array.isArray(node.files_written) && node.files_written.length > 0
      ? node.files_written.map(String).slice(-8)
      : [],
    position: computeAgentCanvasPosition(canvasIndex, canvasTotal, String(node.status || status)),
  };
}

/**
 * GET /api/tasks/sandboxes?sessionId=&focusNodeId=
 * Returns virtual sandbox tiles for active agents.
 */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId');
  const focusNodeId = req.nextUrl.searchParams.get('focusNodeId');
  const projectId = req.nextUrl.searchParams.get('project_id');

  const [browser, workers] = await Promise.all([fetchBrowserStatus(), fetchEngineWorkers()]);
  const engineOnline = workers.length > 0 || browser.online;

  let sandboxes: AgentSandbox[] = [];

  if (sessionId) {
    const session = getSession(sessionId);
    if (session) {
      let active = flattenActive(session.nodes);
      // Prefer focused node first
      if (focusNodeId) {
        const focused = findNode(session.nodes, focusNodeId);
        if (focused) {
          active = [focused, ...active.filter((n) => n.id !== focusNodeId)];
        }
      }
      // If nothing active yet, show first few pending leaves so grid isn't empty mid-decomp
      if (!active.length) {
        const pending: any[] = [];
        const walk = (list: any[]) => {
          for (const n of list || []) {
            if (!n.children?.length && n.status !== 'completed') pending.push(n);
            if (n.children) walk(n.children);
          }
        };
        walk(session.nodes);
        active = pending.slice(0, 4);
      }
      const slice = active.slice(0, MAX_VISIBLE);
      sandboxes = slice.map((n, idx) =>
        nodeToSandbox(n, browser, focusNodeId, findParentId(session.nodes, n.id), idx, slice.length),
      );
    }
  }

  // Merge busy engine workers that aren't already represented
  for (const w of workers) {
    if (sandboxes.length >= MAX_VISIBLE) break;
    if (w.status !== 'busy' && w.status !== 'running') continue;
    const id = w.id || w.worker_id;
    if (sandboxes.some((s) => s.agentId === id)) continue;
    const engIdx = sandboxes.length;
    sandboxes.push({
      id: `sbx-eng-${id}`,
      agentId: id,
      nodeId: w.task_id || id,
      label: w.current_task || w.model || id,
      mode: 'shell',
      status: 'running',
      position: computeAgentCanvasPosition(engIdx, Math.max(engIdx + 1, MAX_VISIBLE), 'running'),
      modelTier: 'specialist',
      tools: ['shell'],
      cwd: '/workspace/swarm',
      model: w.model || undefined,
      logs: [
        { ts: Date.now(), kind: 'info', text: `engine worker ${id} · ${w.provider || '—'} / ${w.model || '—'} · tps ${w.avg_tps ?? '—'}` },
      ],
      toolCallCount: Number(w.tool_calls) || 0,
      startedAt: Number(w.started_at) || undefined,
    });
  }

  // Ensure at least one browser tile when browser is online and focus wants it
  if (browser.online && focusNodeId && sandboxes.every((s) => s.mode === 'shell' || s.mode === 'edit')) {
    const focus = sandboxes.find((s) => s.nodeId === focusNodeId);
    if (focus && (focus.tools.includes('browser') || focus.mode === 'mixed')) {
      focus.mode = 'browser';
      focus.url = browser.url || focus.url;
      focus.screenshotUrl = browser.screenshotUrl;
    }
  }

  const snap: SandboxGridSnapshot = {
    sandboxes,
    browserOnline: browser.online,
    engineOnline,
    maxVisible: MAX_VISIBLE,
    updatedAt: new Date().toISOString(),
  };

  // projectId reserved for future engine project binding
  void projectId;

  return NextResponse.json({ ok: true, ...snap });
}
