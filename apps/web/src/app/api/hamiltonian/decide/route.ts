import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { engineProxy } from '@/lib/engineProxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Accept the full MCP schema for hamiltonian_decide, plus legacy passthrough
const DecideBody = z.object({
  // MCP hamiltonian_decide fields
  task_id:              z.string().optional(),
  task_label:           z.string().optional(),
  task_description:     z.string().optional(),
  step_index:           z.number().optional(),
  max_steps:            z.number().optional(),
  acceptance_met_ratio: z.number().optional(),
  last_action:          z.string().optional(),
  last_success:         z.boolean().optional(),
  priority:             z.number().optional(),
  time_remaining_sec:   z.number().optional(),
  candidate_actions:    z.array(z.unknown()).optional(),
  // Arena / legacy fields
  state:   z.record(z.string(), z.unknown()).optional(),
  options: z.array(z.unknown()).optional(),
  context: z.unknown().optional(),
}).passthrough();

// ─── Local QRC Fallback ───────────────────────────────────────────────────────
// Energy-minimization heuristic — fires when engine is unreachable (502/504).
// Mirrors the same logic in /api/hamiltonian/route.ts for consistency.

const ACTION_BASE_ENERGY: Record<string, number> = {
  think:               0.15,
  file_write:          0.20,
  file_read:           0.10,
  file_edit:           0.20,
  shell_exec:          0.30,
  web_search:          0.25,
  browse_url:          0.30,
  code_generate:       0.35,
  hamiltonian_decide:  0.05,
  hamiltonian_feedback:0.05,
  task_complete:       0.01,
  task_blocked:        0.99,
  // Arena actions
  MOVE: 0.20,
  TALK: 0.15,
  WORK: 0.25,
  IDLE: 0.50,
  GOTO: 0.20,
};

function localQrcDecide(body: Record<string, unknown>) {
  const stepIndex   = Number(body.step_index   ?? body.stepIndex   ?? 0);
  const maxSteps    = Number(body.max_steps    ?? body.maxSteps    ?? 10);
  const progress    = Number(body.acceptance_met_ratio ?? 0);
  const stepsLeft   = Math.max(1, maxSteps - stepIndex);
  const pressure    = 1 - progress;
  const lastSuccess = body.last_success != null ? Boolean(body.last_success) : true;

  const phase =
    stepIndex === 0   ? 'init'
    : progress < 0.2  ? 'exploration'
    : progress < 0.7  ? 'execution'
    : stepsLeft <= 2  ? 'finalization'
    :                   'verification';

  const pools: Record<string, string[]> = {
    init:         ['think', 'file_read', 'WORK'],
    exploration:  ['think', 'web_search', 'browse_url', 'TALK'],
    execution:    ['code_generate', 'file_write', 'shell_exec', 'WORK'],
    verification: ['shell_exec', 'file_read', 'think'],
    finalization: ['task_complete', 'file_write', 'GOTO'],
  };

  const providedCandidates = Array.isArray(body.candidate_actions)
    ? (body.candidate_actions as Array<{ action: string }>)
    : null;

  const names = providedCandidates
    ? providedCandidates.map((c) => c.action)
    : pools[phase] ?? ['think', 'file_write', 'shell_exec'];

  const scored = names.map((action) => {
    const base = ACTION_BASE_ENERGY[action] ?? 0.45;
    const energy = base
      + pressure * 0.2
      + (lastSuccess ? 0 : 0.1)
      + Math.random() * 0.02;
    return {
      action,
      energy_delta: Number(energy.toFixed(3)),
      confidence:   Number(Math.max(0, 1 - energy).toFixed(3)),
      phase,
    };
  });

  scored.sort((a, b) => a.energy_delta - b.energy_delta);
  const best = scored[0];
  const thinkingStyles = ['think_deep', 'think_fast', 'verify', 'diagnose', 'plan'];

  return {
    ok: true,
    optimal_action:   best.action,
    thinking_style:   thinkingStyles[stepIndex % thinkingStyles.length],
    confidence:       best.confidence,
    energy_delta:     best.energy_delta,
    phase,
    optimal_sequence: scored.slice(0, 4).map((s) => s.action),
    candidate_actions: scored,
    suggested_params:  best.action === 'think'
      ? { reasoning: `Step ${stepIndex}/${maxSteps}: analyze task progress` }
      : {},
    source: 'local_qrc_fallback',
  };
}

export async function POST(req: NextRequest) {
  const parsed = DecideBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', detail: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Try engine first
  const engineRes = await engineProxy(req, '/decide', parsed.data, 8000);

  // If engine returned a successful Hamiltonian decision, pass it through
  if (engineRes.status === 200) {
    const data = await engineRes.json().catch(() => null);
    if (data?.ok && data?.optimal_action) {
      return NextResponse.json({ ...data, source: 'engine' });
    }
  }

  // Engine unreachable or returned error — use local QRC fallback
  // This ensures all sandbox agents always get a valid Hamiltonian decision
  return NextResponse.json(localQrcDecide(parsed.data as Record<string, unknown>));
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    tool: 'hamiltonian_decide',
    description: 'POST task state → minimum-energy optimal next action.',
    required: ['task_id', 'task_label', 'step_index', 'max_steps'],
    optional: ['acceptance_met_ratio', 'last_action', 'last_success', 'priority', 'time_remaining_sec'],
  });
}
