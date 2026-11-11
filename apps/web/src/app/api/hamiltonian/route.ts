/**
 * /api/hamiltonian — Hamiltonian Quantum Reservoir Computing MCP Gateway
 *
 * Replaces the planned() stub. Proxies to the Python engine's /leaf/decide,
 * /leaf/feedback, and /leaf/rank endpoints. Falls back to a local
 * energy-minimization heuristic if the engine is unreachable.
 *
 * POST body: { tool: 'decide' | 'rank_actions' | 'feedback', ...params }
 * GET:       Returns current Hamiltonian status + engine health.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENGINE_URL = (process.env.ENGINE_URL || 'http://localhost:8410').replace(/\/$/, '');

// ─── Types ──────────────────────────────────────────────────────────────────

interface DecidePayload {
  task_id: string;
  task_label: string;
  task_description?: string;
  step_index: number;
  max_steps: number;
  acceptance_met_ratio?: number;
  last_action?: string;
  last_success?: boolean;
  priority?: number;
  time_remaining_sec?: number;
}

interface CandidateAction {
  action: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

interface RankPayload {
  task_goal: string;
  current_state_summary?: string;
  candidate_actions: CandidateAction[];
}

interface FeedbackPayload {
  task_id: string;
  action: string;
  reward: number;
  step_index?: number;
}

// ─── Local QRC Fallback ──────────────────────────────────────────────────────
// Energy-minimization heuristic used when the Python engine is offline.
// Models each action as an energy cost relative to goal completion:
//   E(a) = base_cost(a) + uncertainty_penalty + (1 - acceptance_met_ratio) * pressure

const ACTION_BASE_ENERGY: Record<string, number> = {
  think:             0.15,
  file_write:        0.20,
  file_read:         0.10,
  file_edit:         0.20,
  shell_exec:        0.30,
  web_search:        0.25,
  browse_url:        0.30,
  code_generate:     0.35,
  hamiltonian_decide:0.05,
  hamiltonian_feedback: 0.05,
  task_complete:     0.01,
  task_blocked:      0.99,
};

function localDecide(p: DecidePayload) {
  const progress = p.acceptance_met_ratio ?? 0;
  const stepsLeft = Math.max(1, p.max_steps - p.step_index);
  const pressure = 1 - progress;

  // Phase detection
  const phase =
    p.step_index === 0                   ? 'init'
    : progress < 0.2                    ? 'exploration'
    : progress < 0.7                    ? 'execution'
    : stepsLeft <= 2                    ? 'finalization'
    :                                     'verification';

  // Candidate pool per phase
  const pools: Record<string, string[]> = {
    init:         ['think', 'file_read', 'web_search'],
    exploration:  ['think', 'web_search', 'browse_url', 'file_read'],
    execution:    ['code_generate', 'file_write', 'shell_exec', 'file_edit'],
    verification: ['shell_exec', 'file_read', 'think'],
    finalization: ['task_complete', 'file_write', 'shell_exec'],
  };

  const candidates = pools[phase] ?? ['think', 'file_write', 'shell_exec'];

  // Compute energy for each candidate
  const scored = candidates.map((action) => {
    const base = ACTION_BASE_ENERGY[action] ?? 0.5;
    const energy = base + pressure * 0.2 + (p.last_success === false ? 0.1 : 0);
    return { action, energy_delta: Number(energy.toFixed(3)), confidence: Number((1 - energy).toFixed(3)), phase };
  });

  scored.sort((a, b) => a.energy_delta - b.energy_delta);
  const best = scored[0];

  const thinkingStyles = ['think_deep', 'think_fast', 'verify', 'diagnose', 'plan'];
  const thinking_style = thinkingStyles[p.step_index % thinkingStyles.length];

  return {
    ok: true,
    optimal_action: best.action,
    thinking_style,
    confidence: best.confidence,
    energy_delta: best.energy_delta,
    phase,
    optimal_sequence: scored.slice(0, 4).map((s) => s.action),
    candidate_actions: scored,
    suggested_params: best.action === 'think'
      ? { reasoning: `Step ${p.step_index}/${p.max_steps}: analyze progress toward ${p.task_label}` }
      : {},
    source: 'local_qrc_fallback',
  };
}

function localRankActions(p: RankPayload) {
  const scored = p.candidate_actions.map((c) => {
    const base = ACTION_BASE_ENERGY[c.action] ?? 0.5;
    return {
      ...c,
      energy_delta: Number((base + Math.random() * 0.05).toFixed(3)),
      confidence: Number((1 - base).toFixed(3)),
      rank: 0,
    };
  });
  scored.sort((a, b) => a.energy_delta - b.energy_delta);
  scored.forEach((s, i) => { s.rank = i + 1; });
  return { ok: true, ranked_actions: scored, source: 'local_qrc_fallback' };
}

// ─── Engine Proxy ────────────────────────────────────────────────────────────

async function proxyDecide(payload: DecidePayload) {
  try {
    const res = await fetch(`${ENGINE_URL}/leaf/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`engine ${res.status}`);
    const data = await res.json();
    if (data?.ok && data.optimal_action) return { ...data, source: 'engine' };
  } catch {
    /* fall through to local */
  }
  return localDecide(payload);
}

async function proxyRank(payload: RankPayload) {
  try {
    const res = await fetch(`${ENGINE_URL}/leaf/rank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`engine ${res.status}`);
    const data = await res.json();
    if (data?.ok) return { ...data, source: 'engine' };
  } catch {
    /* fall through to local */
  }
  return localRankActions(payload);
}

async function proxyFeedback(payload: FeedbackPayload) {
  try {
    await fetch(`${ENGINE_URL}/leaf/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* best-effort, no fallback needed */
  }
  return { ok: true, source: 'acknowledged' };
}

// ─── Route Handlers ──────────────────────────────────────────────────────────

export async function GET() {
  // Health + status
  let engineOnline = false;
  let engineLatencyMs: number | null = null;

  try {
    const t = Date.now();
    const res = await fetch(`${ENGINE_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    engineOnline = res.ok;
    engineLatencyMs = Date.now() - t;
  } catch {
    /* offline */
  }

  return Response.json({
    ok: true,
    status: 'active',
    tools: ['hamiltonian_decide', 'hamiltonian_rank_actions', 'hamiltonian_feedback'],
    engine: {
      url: ENGINE_URL,
      online: engineOnline,
      latency_ms: engineLatencyMs,
    },
    fallback: 'local_qrc',
    description: 'Hamiltonian Quantum Reservoir Computing — minimum-energy action oracle for all swarm agents.',
  });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const tool = String(body.tool || '');

  // ── hamiltonian_decide ────────────────────────────────────────────────────
  if (tool === 'decide' || tool === 'hamiltonian_decide') {
    const payload: DecidePayload = {
      task_id:            String(body.task_id || body.taskId || 'unknown'),
      task_label:         String(body.task_label || body.taskLabel || ''),
      task_description:   body.task_description ? String(body.task_description) : undefined,
      step_index:         Number(body.step_index ?? body.stepIndex ?? 0),
      max_steps:          Number(body.max_steps ?? body.maxSteps ?? 10),
      acceptance_met_ratio: body.acceptance_met_ratio != null ? Number(body.acceptance_met_ratio) : undefined,
      last_action:        body.last_action ? String(body.last_action) : undefined,
      last_success:       body.last_success != null ? Boolean(body.last_success) : undefined,
      priority:           body.priority != null ? Number(body.priority) : undefined,
      time_remaining_sec: body.time_remaining_sec != null ? Number(body.time_remaining_sec) : undefined,
    };
    const result = await proxyDecide(payload);
    return Response.json(result);
  }

  // ── hamiltonian_rank_actions ──────────────────────────────────────────────
  if (tool === 'rank' || tool === 'rank_actions' || tool === 'hamiltonian_rank_actions') {
    const candidates = Array.isArray(body.candidate_actions) ? body.candidate_actions as CandidateAction[] : [];
    const payload: RankPayload = {
      task_goal:             String(body.task_goal || body.taskGoal || ''),
      current_state_summary: body.current_state_summary ? String(body.current_state_summary) : undefined,
      candidate_actions:     candidates,
    };
    const result = await proxyRank(payload);
    return Response.json(result);
  }

  // ── hamiltonian_feedback ──────────────────────────────────────────────────
  if (tool === 'feedback' || tool === 'hamiltonian_feedback') {
    const payload: FeedbackPayload = {
      task_id:    String(body.task_id || body.taskId || 'unknown'),
      action:     String(body.action || ''),
      reward:     Number(body.reward ?? 0.5),
      step_index: body.step_index != null ? Number(body.step_index) : undefined,
    };
    const result = await proxyFeedback(payload);
    return Response.json(result);
  }

  return Response.json(
    { ok: false, error: `Unknown tool "${tool}". Use: decide | rank_actions | feedback` },
    { status: 400 }
  );
}

// Legacy method stubs — now fully implemented via POST
export async function PUT() {
  return Response.json({ ok: false, error: 'Use POST with tool field' }, { status: 405 });
}
export async function PATCH() {
  return Response.json({ ok: false, error: 'Use POST with tool field' }, { status: 405 });
}
export async function DELETE() {
  return Response.json({ ok: false, error: 'Use POST with tool field' }, { status: 405 });
}
