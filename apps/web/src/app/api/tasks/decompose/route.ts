// Hierarchical Task Decomposition via DeepSeek V4 Flash (Azure Foundry)
// Accepts time requirement + project description, produces a multi-level DAG
// Auto-deepens oversized leaves until they fit small-model workers + user budget
//
// Used by: Dashboard Decompose tab, Workstation, Zero UI

import { NextRequest, NextResponse } from 'next/server';
import {
  parseTimeToMinutes,
  computeBudgetTargets,
  computeFitMeter,
  summarizeTreeEffort,
  computeTreeSummary,
  formatMinutes,
  ambitionBrief,
  phaseLabelsForBudget,
  type BudgetTargets,
  type FitMeter,
  type TreeSummary,
} from '@/lib/timeBudget';
import {
  getSession,
  setSession,
  hydrateSession,
  hydrateActiveSessionForUser,
  getUserSessionIndex,
  findNode,
  type DecompSessionRecord,
} from '@/lib/decompSessions';
import {
  sanitizeMission,
  parseModelJson,
  buildFallbackTree,
  heuristicSplitLeaf,
  repairTreeStructure,
  extractNodesFromModel,
  domainPromptHint,
  type SanitizedMission,
} from '@/lib/decompEngine';
import { deepseekChat, isDeepSeekConfigured } from '@/lib/deepseek';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_DEEPEN_ROUNDS = 10;
const MAX_DEEPEN_CALLS = 48;

function deepenLimitsForBudget(budgetMinutes: number): { rounds: number; calls: number } {
  const m = budgetMinutes || 60;
  if (m <= 5) return { rounds: 1, calls: 2 };
  if (m <= 15) return { rounds: 2, calls: 6 };
  if (m <= 30) return { rounds: 3, calls: 12 };
  if (m <= 60) return { rounds: 5, calls: 20 };
  if (m >= 10080) return { rounds: 40, calls: 200 };
  if (m >= 1440) return { rounds: 24, calls: 120 };
  if (m >= 180) return { rounds: 16, calls: 72 };
  return { rounds: MAX_DEEPEN_ROUNDS, calls: MAX_DEEPEN_CALLS };
}
const DEEPEN_CONCURRENCY = 4;
const DEEPEN_BATCH_SIZE = 6;
const LLM_TIMEOUT_MS = 120_000;
const LLM_RETRIES = 2;

// ── Prompt templates ───────────────────────────────────────────────

function buildDecomposePrompt(
  phase: 'initial' | 'deepen',
  parentContext: Record<string, unknown>,
  targets: BudgetTargets
) {
  if (phase === 'initial') {
    const domain = String(parentContext.domain || 'general');
    const constraints = Array.isArray(parentContext.constraints)
      ? (parentContext.constraints as string[]).join('; ')
      : '';
    const phases = phaseLabelsForBudget(targets.budgetMinutes).join(' → ');
    return `You are the SwarmAgents Architect. Decompose ANY mission into a hierarchical tree sized for the user's wall-clock budget.
Handle vague, messy, or non-software tasks by inventing a practical work breakdown — never refuse, never return an empty tree.

${ambitionBrief(targets.budgetMinutes)}

Suggested phase spine (adapt names to the mission, keep this order of value delivery): ${phases}

The user has provided:
- Project: ${parentContext.project}
- Domain hint: ${domain} — ${domainPromptHint(domain as any)}
- Time Requirement: ${parentContext.timeRequirement} (${targets.budgetMinutes} minutes wall-clock)
- Target leaf count: ~${targets.targetLeaves} (hard max ${targets.maxLeaves})
- Target leaf size: ${targets.targetLeafMinutes} minutes each (deepen anything above ${targets.deepenAboveMinutes}m)
- Top-level areas: ${targets.topLevelAreas.min}-${targets.topLevelAreas.max}
- Children per area (first pass): ${targets.childrenPerArea.min}-${targets.childrenPerArea.max}
${constraints ? `- Soft constraints: ${constraints}` : ''}

## Rules
1. Break the project into ${targets.topLevelAreas.min}-${targets.topLevelAreas.max} TOP-LEVEL areas that match the phase spine above (foundation → MVP → harden → expand → iterate). Names must be mission-specific, not generic.
2. For each top-level area, create ${targets.childrenPerArea.min}-${targets.childrenPerArea.max} sub-tasks
3. Each leaf should be completable in one focused worker pass (~${targets.targetLeafMinutes}m). For budgets ≤15 minutes keep leaves coarse (a real deliverable), not micro-fragments.
4. Mark any leaf still too large with "needs_deeper": true AND effort_minutes > ${targets.deepenAboveMinutes}
5. Order by dependency — earlier tasks first; use depends_on for cross-area deps (ids must exist). MVP-runnable path comes before polish/expansion.
6. Assign priority: critical | high | medium | low
7. Estimate effort for each leaf in "effort_minutes" (integer, ideally ${targets.targetLeafMinutes}-${targets.deepenAboveMinutes})
8. Aim for TOTAL serial effort ≈ ${Math.round(targets.budgetMinutes * (targets.budgetMinutes <= 15 ? 1.5 : targets.budgetMinutes <= 60 ? 2 : 3))} minutes across all leaves (parallel workers compress this to ~${targets.label} wall-clock). Stay near the target — do NOT overshoot maxLeaves (${targets.maxLeaves}).
9. Prefer a small number of clear, shippable leaves for short budgets (≤15m). Only use many tiny leaves when the budget is ≥1 hour.
10. If the objective is vague, invent concrete deliverables and acceptance criteria that still serve the user's intent
11. LABEL QUALITY (mandatory): every area/leaf label must name a concrete artifact, module, API, file, or user-visible outcome tied to THIS mission. FORBIDDEN labels/patterns: "Plan work", "Setup", "Setup 1", "Unit 2", "Execute", "Clarify objective", "Finalize", "Part N", numbered filler without substance.
12. Descriptions must say WHAT to build/change and WHERE (path or artifact). acceptance_criteria must be checkable.
13. For budgets ≥ 1 day: include an early “shippable MVP” checkpoint area, then quality/hardening, then expansion leaves that keep improving the same codebase until the leaf budget is met.
14. Return ONLY valid JSON (no markdown fences, no commentary)

## Output JSON schema:
{
  "project_title": "...",
  "total_effort_estimate": "X-Y hours",
  "nodes": [
    {
      "id": "area-1",
      "type": "area",
      "label": "Mission-specific area (e.g. Auth API foundation)",
      "description": "Brief description",
      "children": [
        {
          "id": "task-1-1",
          "type": "task",
          "label": "Write src/auth/session.ts createSession()",
          "description": "What to do (1-2 sentences) with path/artifact",
          "acceptance_criteria": ["Measurable done check 1", "Done check 2"],
          "priority": "critical",
          "effort_minutes": ${targets.targetLeafMinutes},
          "needs_deeper": false,
          "depends_on": [],
          "agent_class": "specialist",
          "model_tier": "specialist",
          "tools": ["edit"],
          "deliverable_path": "src/path/or/artifact"
        }
      ]
    }
  ]
}

Field rules for EVERY leaf:
- acceptance_criteria: 1-2 short measurable checks (required)
- tools: subset of shell | browser | edit | test | search
- model_tier: grunt (tiny local) | specialist (mid) | architect (hard reasoning)
- agent_class: orchestrator | architect | specialist | grunt | qa | research | frontend | backend
- depends_on: ids of sibling/cross-area tasks that must finish first (not just parent)
- deliverable_path: file/path/URL the worker should produce

CRITICAL: Set "needs_deeper": true on any task a 5GB model cannot finish in one shot.
Each leaf must be atomic — write a function, create a file, write a test, run a command, gather one source, draft one section.
Never return zero nodes.`;
  }

  return `You are the SwarmAgents Architect. A parent task is too large for a small worker model.
Decompose it into 2-5 atomic sub-tasks of ~${targets.targetLeafMinutes} minutes each (max ${targets.deepenAboveMinutes}m).
If the parent is vague, invent concrete sub-steps that name real artifacts (file/function/test). Never return an empty subtasks array.
Banned labels: "Setup", "Unit N", "Plan work", "Execute", "Finalize" without a concrete artifact name.

${ambitionBrief(targets.budgetMinutes)}

Parent Task: ${parentContext.label}
Description: ${parentContext.description || ''}
Parent effort: ${parentContext.effort_minutes || '?'} minutes
Remaining project wall-clock: ${parentContext.remainingTime || targets.label}
Current tree leaf count: ${parentContext.currentLeaves || '?'} / target ${targets.targetLeaves}

Each sub-task MUST be completable by a small model in one shot.
Do NOT create sub-tasks larger than ${targets.deepenAboveMinutes} minutes.
tools: shell | browser | edit | test | search
model_tier: grunt | specialist | architect
Return ONLY valid JSON (no markdown).

Output JSON:
{
  "subtasks": [
    {
      "id": "${parentContext.id}-sub-1",
      "label": "Concrete atomic sub-task with path/artifact",
      "description": "What to do and where",
      "acceptance_criteria": ["Done when …"],
      "priority": "high",
      "effort_minutes": ${targets.targetLeafMinutes},
      "needs_deeper": false,
      "depends_on": [],
      "agent_class": "grunt",
      "model_tier": "grunt",
      "tools": ["edit"],
      "deliverable_path": ""
    }
  ]
}`;
}

// ── DeepSeek/Azure API call (via engine gateway) ───────────────────

async function callDeepSeekOnce(
  system: string,
  user: string,
  temperature: number,
  maxTokens: number,
  userIdOrEmail?: string
): Promise<Record<string, unknown>> {
  if (userIdOrEmail && !isDeepSeekConfigured(userIdOrEmail)) {
    throw new Error(
      'Azure quota is reserved for admin user (yaeger). Non-admin users must BYOK (Bring Your Own Key) or run local Ollama models.'
    );
  }

  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), LLM_TIMEOUT_MS);

  try {
    const raw = await deepseekChat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature, maxTokens, signal: ctl.signal },
      userIdOrEmail
    );
    try {
      const { tickRoleUsage } = await import('@/lib/routingStore');
      // Azure responses do not always surface usage here; bill a light estimate.
      const approxTokens = Math.max(1, Math.ceil((system.length + user.length + raw.length) / 4));
      await tickRoleUsage('architect', {
        tokens: approxTokens,
        costUsd: approxTokens * 0.000002,
      });
    } catch {
      /* non-fatal */
    }
    return parseModelJson(raw);
  } finally {
    clearTimeout(timeout);
  }
}

async function callDeepSeek(
  system: string,
  user: string,
  temperature = 0.3,
  maxTokens = 4096,
  userIdOrEmail?: string
): Promise<Record<string, unknown>> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < LLM_RETRIES; attempt++) {
    try {
      const temp = attempt === 0 ? temperature : Math.min(0.55, temperature + 0.15);
      const result = await callDeepSeekOnce(
        system,
        attempt === 0
          ? user
          : `${user}\n\nIMPORTANT: Previous reply was invalid. Return ONLY a single valid JSON object matching the schema.`,
        temp,
        maxTokens,
        userIdOrEmail
      );
      return result;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr || new Error('llm_failed');
}

function collectDeepenCandidates(nodes: any[], targets: BudgetTargets, depth = 0): any[] {
  const out: any[] = [];
  for (const n of nodes || []) {
    const kids = n.children;
    if (kids && kids.length > 0) {
      out.push(...collectDeepenCandidates(kids, targets, depth + 1));
      continue;
    }
    const effort = Number(n.effort_minutes ?? 10) || 10;
    const tooBig = n.needs_deeper === true || effort > targets.deepenAboveMinutes;
    const canGoDeeper = depth < targets.maxDepth && n._deepenAttempts !== true;
    if (tooBig && canGoDeeper) out.push(n);
  }
  return out;
}

const VALID_TOOLS = new Set(['shell', 'browser', 'edit', 'test', 'search']);
const VALID_TIERS = new Set(['grunt', 'specialist', 'architect']);

function normalizeTools(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ['edit'];
  const tools = raw.map(String).map((t) => t.toLowerCase()).filter((t) => VALID_TOOLS.has(t));
  return tools.length ? Array.from(new Set(tools)) : ['edit'];
}

function normalizeCriteria(raw: unknown, description?: string): string[] {
  if (Array.isArray(raw) && raw.length) {
    return raw.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 4);
  }
  if (description?.trim()) return [`Done when: ${description.trim().slice(0, 120)}`];
  return ['Produces the stated deliverable without errors'];
}

function inferTier(agentClass: string, explicit?: string): string {
  if (explicit && VALID_TIERS.has(explicit)) return explicit;
  if (agentClass === 'architect' || agentClass === 'orchestrator') return 'architect';
  if (agentClass === 'grunt' || agentClass === 'qa') return 'grunt';
  return 'specialist';
}

function normalizeNodes(nodes: any[], parentId?: string, depth = 0): any[] {
  return (nodes || []).map((n, i) => {
    const id = String(n.id || `node-${depth}-${i + 1}`);
    const agent_class = n.agent_class || (n.children?.length ? 'architect' : 'grunt');
    const children = n.children?.length
      ? normalizeNodes(n.children, id, depth + 1)
      : undefined;
    const isLeaf = !children?.length;
    const effort = Math.max(1, Number(n.effort_minutes) || 10);
    return {
      ...n,
      id,
      parentId,
      depth,
      type: n.type || (children?.length ? 'area' : 'task'),
      label: String(n.label || n.description || id).slice(0, 160),
      description: String(n.description || n.label || '').slice(0, 600),
      status: n.status || 'pending',
      effort_minutes: effort,
      needs_deeper: Boolean(n.needs_deeper),
      depends_on: Array.isArray(n.depends_on) ? n.depends_on.map(String) : [],
      agent_class,
      model_tier: isLeaf ? inferTier(agent_class, n.model_tier) : undefined,
      tools: isLeaf ? normalizeTools(n.tools) : undefined,
      acceptance_criteria: isLeaf
        ? normalizeCriteria(n.acceptance_criteria, n.description || n.label)
        : undefined,
      deliverable_path: isLeaf
        ? String(n.deliverable_path || `deliverables/${id}`).slice(0, 200)
        : undefined,
      children,
      runCount: n.runCount || 0,
    };
  });
}

function finalizeTree(
  rawNodes: any[],
  targets: BudgetTargets,
  mission?: SanitizedMission
): { nodes: any[]; repair: ReturnType<typeof repairTreeStructure>['stats'] } {
  const repaired = repairTreeStructure(rawNodes, targets, mission);
  const nodes = normalizeNodes(repaired.nodes);
  // Second pass: scrub deps against normalized ids + re-apply deepen flags from targets
  const applyTargets = (list: any[], depth = 0) => {
    for (const n of list || []) {
      if (n.children?.length) {
        applyTargets(n.children, depth + 1);
        n.needs_deeper = false;
      } else {
        const effort = Number(n.effort_minutes) || targets.targetLeafMinutes;
        n.needs_deeper =
          Boolean(n.needs_deeper) ||
          (effort > targets.deepenAboveMinutes && depth < targets.maxDepth);
        n.effort_minutes = Math.max(1, effort);
      }
    }
  };
  applyTargets(nodes);
  return { nodes, repair: repaired.stats };
}

async function deepenNode(
  parent: any,
  session: any,
  targets: BudgetTargets,
  currentLeaves: number
): Promise<number> {
  parent._deepenAttempts = true;
  const system = buildDecomposePrompt(
    'deepen',
    {
      id: parent.id,
      label: parent.label,
      description: parent.description || '',
      effort_minutes: parent.effort_minutes,
      remainingTime: session.timeRequirement || targets.label,
      currentLeaves,
    },
    targets
  );

  const userOwner = session.ownerUserId || session.ownerEmail;
  let rawSubs: any[] = [];
  try {
    const result = await callDeepSeek(
      system,
      'Break this task into atomic sub-tasks.',
      0.3,
      2048,
      userOwner
    );
    rawSubs = extractNodesFromModel(result);
    if (!rawSubs.length && Array.isArray((result as any).subtasks)) {
      rawSubs = (result as any).subtasks;
    }
  } catch {
    rawSubs = [];
  }

  if (!rawSubs.length) {
    rawSubs = heuristicSplitLeaf(parent, targets);
  }

  const room = Math.max(0, targets.maxLeaves - currentLeaves);
  const capped = rawSubs.slice(0, Math.min(5, Math.max(2, room || 5)));
  const prepared = capped.map((st: any, i: number) => ({
    ...st,
    id: st.id || `${parent.id}-sub-${i + 1}`,
    type: 'task',
    priority: st.priority || 'high',
    agent_class: st.agent_class || 'grunt',
    effort_minutes: Math.max(
      1,
      Math.min(
        targets.deepenAboveMinutes * 2,
        Number(st.effort_minutes ?? targets.targetLeafMinutes) || targets.targetLeafMinutes
      )
    ),
    needs_deeper:
      Boolean(st.needs_deeper) ||
      (Number(st.effort_minutes) || 0) > targets.deepenAboveMinutes,
    status: 'pending' as const,
  }));

  const { nodes: subtasks } = finalizeTree(prepared, targets);
  // Keep as flat children under parent (not nested areas)
  const flat = subtasks.flatMap((n) => (n.children?.length ? n.children : [n]));

  if (!flat.length) {
    parent.needs_deeper = false;
    return 0;
  }

  parent.children = parent.children || [];
  parent.children.push(
    ...normalizeNodes(flat, parent.id, (parent.depth || 0) + 1)
  );
  parent.needs_deeper = false;
  parent.type = parent.type === 'task' ? 'area' : parent.type || 'area';
  return flat.length;
}

function setProgress(
  session: any,
  patch: {
    phase: 'initial' | 'deepening' | 'done' | 'error';
    round?: number;
    deepenCalls?: number;
    leafCount?: number;
    targetLeaves?: number;
    message?: string;
  }
) {
  const { leafCount } = summarizeTreeEffort(session.nodes);
  session.progress = {
    phase: patch.phase,
    round: patch.round ?? session.progress?.round ?? 0,
    deepenCalls: patch.deepenCalls ?? session.progress?.deepenCalls ?? 0,
    leafCount: patch.leafCount ?? leafCount,
    targetLeaves: patch.targetLeaves ?? session.target_leaves ?? 0,
    message: patch.message ?? session.progress?.message ?? '',
    updatedAt: Date.now(),
  };
}

/** One parallel deepen batch. Returns whether more work remains. */
async function autoDeepenStep(
  session: any,
  targets: BudgetTargets,
  opts: { round?: number; deepenCalls?: number } = {}
): Promise<{ deepenCalls: number; round: number; done: boolean; batchSize: number }> {
  let deepenCalls = opts.deepenCalls ?? session.auto_deepen?.deepenCalls ?? 0;
  const round = (opts.round ?? session.auto_deepen?.rounds ?? 0) + 1;

  const { leafCount } = summarizeTreeEffort(session.nodes);
  const limits = deepenLimitsForBudget(targets.budgetMinutes || session.budget_minutes || 60);
  if (leafCount >= targets.maxLeaves || deepenCalls >= limits.calls || round > limits.rounds) {
    return { deepenCalls, round, done: true, batchSize: 0 };
  }

  const candidates = collectDeepenCandidates(session.nodes, targets);
  if (!candidates.length) {
    return { deepenCalls, round, done: true, batchSize: 0 };
  }

  candidates.sort(
    (a, b) => (Number(b.effort_minutes) || 0) - (Number(a.effort_minutes) || 0)
  );

  const batch = candidates.slice(
    0,
    Math.min(DEEPEN_BATCH_SIZE, limits.calls - deepenCalls)
  );

  let added = 0;
  // Parallel deepen within batch (capped concurrency)
  for (let i = 0; i < batch.length; i += DEEPEN_CONCURRENCY) {
    const slice = batch.slice(i, i + DEEPEN_CONCURRENCY);
    const lc = summarizeTreeEffort(session.nodes).leafCount;
    if (lc >= targets.maxLeaves) break;
    const results = await Promise.all(
      slice.map((parent) => deepenNode(parent, session, targets, lc))
    );
    added += results.reduce((s, n) => s + n, 0);
    deepenCalls += slice.length;
  }

  // If LLM deepen produced nothing, force heuristic splits on remaining oversized leaves
  if (added === 0 && batch.length) {
    for (const parent of batch) {
      if (parent.children?.length) continue;
      const subs = heuristicSplitLeaf(parent, targets);
      if (!subs.length) {
        parent.needs_deeper = false;
        continue;
      }
      parent.children = normalizeNodes(subs, parent.id, (parent.depth || 0) + 1);
      parent.needs_deeper = false;
      parent.type = 'area';
      parent._deepenAttempts = true;
      added += subs.length;
    }
  }

  const fit = computeFitMeter(session.nodes, targets.budgetMinutes, targets);
  const stillBig = collectDeepenCandidates(session.nodes, targets);
  const stalled = added === 0 && stillBig.length > 0;
  const done =
    stillBig.length === 0 ||
    deepenCalls >= limits.calls ||
    fit.leafCount >= targets.maxLeaves ||
    stalled ||
    (fit.leafCount >= targets.targetLeaves * 0.85 && stillBig.length === 0);

  // Cap runaway needs_deeper when we're done
  if (done && stillBig.length) {
    for (const n of stillBig) n.needs_deeper = false;
  }

  setProgress(session, {
    phase: done ? 'done' : 'deepening',
    round,
    deepenCalls,
    leafCount: fit.leafCount,
    targetLeaves: targets.targetLeaves,
    message: done
      ? `Tree ready — ${fit.leafCount} leaves (${fit.status})`
      : `Deepening… ${fit.leafCount}/${targets.targetLeaves} leaves · round ${round}`,
  });

  return { deepenCalls, round, done, batchSize: batch.length };
}

async function autoDeepenTree(session: any, targets: BudgetTargets): Promise<{
  deepenCalls: number;
  rounds: number;
}> {
  let deepenCalls = 0;
  let rounds = 0;

  const limits = deepenLimitsForBudget(targets.budgetMinutes);
  for (let i = 0; i < limits.rounds; i++) {
    const step = await autoDeepenStep(session, targets, { round: rounds, deepenCalls });
    deepenCalls = step.deepenCalls;
    rounds = step.round;
    if (step.done) break;
  }

  return { deepenCalls, rounds };
}

function attachFit(session: any, targets: BudgetTargets): FitMeter {
  const fit = computeFitMeter(session.nodes, targets.budgetMinutes, targets);
  const summary: TreeSummary = computeTreeSummary(session.nodes);
  session.fit = fit;
  session.summary = summary;
  session.budget_minutes = targets.budgetMinutes;
  session.target_leaves = targets.targetLeaves;
  session.total_effort = `${formatMinutes(fit.estimatedMinutes)} serial · ${fit.leafCount} leaves · CP ${formatMinutes(summary.criticalPathMinutes)} · ×${summary.parallelWidth} parallel`;
  return fit;
}

// ── GET — return task info ─────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get('session');
  const nodeId = searchParams.get('node');
  const userId = searchParams.get('userId') || searchParams.get('user');
  const mine = searchParams.get('mine') === '1' || searchParams.get('active') === '1';

  if (mine && userId) {
    const session = await hydrateActiveSessionForUser(userId);
    const index = await getUserSessionIndex(userId);
    if (!session) {
      return NextResponse.json({
        ok: true,
        session: null,
        recent: index.recent,
      });
    }
    return NextResponse.json({
      ok: true,
      session,
      recent: index.recent,
      fit: session.fit,
      summary: session.summary,
    });
  }

  if (sessionId) {
    const session = await hydrateSession(sessionId);
    if (session) {
      if (userId && session.ownerUserId && session.ownerUserId !== userId) {
        return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
      }
      if (nodeId) {
        const node = findNode(session.nodes, nodeId);
        return NextResponse.json({ ok: true, node });
      }
      return NextResponse.json({
        ok: true,
        session,
        fit: session.fit,
        summary: session.summary,
      });
    }
  }

  return NextResponse.json({ ok: false, error: 'session_not_found' }, { status: 404 });
}

// ── POST — decompose or deepen ─────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      action,
      project,
      timeRequirement,
      timeBudgetMinutes,
      time_budget_hours,
      nodeId,
      sessionId,
      autoDeepen = true,
      /** Return shallow tree immediately; client polls deepen_step */
      progressive = true,
    } = body;

    const budgetMinutes =
      typeof timeBudgetMinutes === 'number' && Number.isFinite(timeBudgetMinutes)
        ? Math.max(1 / 3, timeBudgetMinutes)
        : parseTimeToMinutes(timeBudgetMinutes ?? timeRequirement ?? time_budget_hours);
    const targets = computeBudgetTargets(budgetMinutes);

    if (action === 'decompose') {
      if (!project || !String(project).trim()) {
        return NextResponse.json({ ok: false, error: 'missing_project' }, { status: 400 });
      }

      let projectDescriptionWithAttachments = project;
      if (body.github_repo) {
        projectDescriptionWithAttachments += `\n\n[GitHub Repository URL]: ${body.github_repo}`;
      }
      
      // Ingest up to 50 attachments with content extraction
      if (Array.isArray(body.attached_files) && body.attached_files.length > 0) {
        const fileSummaries = body.attached_files.slice(0, 50).map((f: any) => {
          if (typeof f === 'string') return `- File: ${f}`;
          const name = f.name || 'document';
          const content = f.content ? `:\n"""\n${String(f.content).slice(0, 2000)}\n"""` : '';
          return `- File: ${name}${content}`;
        });
        projectDescriptionWithAttachments += `\n\n[Attached Context Documents (${body.attached_files.length})]:\n${fileSummaries.join('\n')}`;
      }

      if (Array.isArray(body.attached_images) && body.attached_images.length > 0) {
        const imageList = body.attached_images.slice(0, 50).map((img: any) => {
          return typeof img === 'string' ? `- Image: ${img}` : `- Image: ${img.name || 'image.png'}`;
        });
        projectDescriptionWithAttachments += `\n\n[Attached Reference Images (${body.attached_images.length})]:\n${imageList.join('\n')}`;
      }

      const mission = sanitizeMission(projectDescriptionWithAttachments);
      const timeLabel =
        typeof timeRequirement === 'string' && timeRequirement.trim()
          ? timeRequirement
          : formatMinutes(budgetMinutes);

      const system = buildDecomposePrompt(
        'initial',
        {
          project: mission.text.slice(0, 30000),
          timeRequirement: timeLabel,
          domain: mission.domain,
          constraints: mission.constraints,
        },
        targets
      );

      let result: Record<string, unknown> | null = null;
      let source: 'llm' | 'fallback' = 'llm';
      let llmError: string | null = null;

      const userIdentifier =
        typeof body.userId === 'string' && body.userId.trim()
          ? body.userId.trim()
          : typeof body.email === 'string' && body.email.trim()
          ? body.email.trim()
          : undefined;

      try {
        result = await callDeepSeek(
          system,
          `Decompose now for a ${timeLabel} wall-clock budget. Target ~${targets.targetLeaves} atomic leaves. Domain=${mission.domain}. Return JSON only.`,
          0.3,
          4096,
          userIdentifier
        );
      } catch (e) {
        llmError = e instanceof Error ? e.message : String(e);
        result = null;
      }

      let rawNodes = result ? extractNodesFromModel(result) : [];
      if (!rawNodes.length) {
        const fb = buildFallbackTree(mission, targets);
        rawNodes = fb.nodes;
        source = 'fallback';
        result = {
          project_title: fb.project_title,
          total_effort_estimate: fb.total_effort_estimate,
          nodes: fb.nodes,
        };
      }

      const { nodes, repair } = finalizeTree(rawNodes, targets, mission);
      // If LLM returned a tiny/broken tree, replace with sized fallback
      const leafProbe = summarizeTreeEffort(nodes).leafCount;
      let finalNodes = nodes;
      let finalRepair = repair;
      if (leafProbe < Math.min(4, Math.floor(targets.targetLeaves * 0.15))) {
        const fb = buildFallbackTree(mission, targets);
        const rebuilt = finalizeTree(fb.nodes, targets, mission);
        finalNodes = rebuilt.nodes;
        finalRepair = { ...rebuilt.repair, usedFallbackShape: true };
        source = 'fallback';
        result = {
          project_title: fb.project_title,
          total_effort_estimate: fb.total_effort_estimate,
          nodes: fb.nodes,
        };
      }

      const session: any = {
        id: `session-${Date.now()}`,
        project: mission.raw,
        ownerUserId:
          typeof body.userId === 'string' && body.userId.trim()
            ? body.userId.trim()
            : undefined,
        mission: {
          title: mission.title,
          domain: mission.domain,
          vague: mission.vague,
          constraints: mission.constraints,
        },
        timeRequirement: timeLabel,
        budget_minutes: budgetMinutes,
        target_leaves: targets.targetLeaves,
        nodes: finalNodes,
        project_title:
          String(result?.project_title || mission.title).slice(0, 80) || mission.title,
        total_effort: String(result?.total_effort_estimate || timeLabel),
        status: 'active' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        auto_deepen: { enabled: Boolean(autoDeepen), deepenCalls: 0, rounds: 0, done: false },
        fit: null as FitMeter | null,
        summary: null as TreeSummary | null,
        progress: null,
        runtime: null,
        decomp_meta: {
          source,
          llmError,
          repair: finalRepair,
          domain: mission.domain,
        },
        github_repo: body.github_repo || undefined,
        attached_files: Array.isArray(body.attached_files) ? body.attached_files : undefined,
        attached_images: Array.isArray(body.attached_images) ? body.attached_images : undefined,
        file_context:
          typeof body.file_context === 'string' ? body.file_context.slice(0, 8000) : undefined,
      };

      const useProgressive = autoDeepen !== false && progressive !== false;

      if (autoDeepen !== false && !useProgressive) {
        // Legacy: block until fully deepened
        const stats = await autoDeepenTree(session, targets);
        session.auto_deepen = { enabled: true, ...stats, done: true };
        setProgress(session, {
          phase: 'done',
          round: stats.rounds,
          deepenCalls: stats.deepenCalls,
          targetLeaves: targets.targetLeaves,
          message: 'Tree ready',
        });
      } else if (useProgressive) {
        const { leafCount } = summarizeTreeEffort(session.nodes);
        setProgress(session, {
          phase: 'deepening',
          round: 0,
          deepenCalls: 0,
          leafCount,
          targetLeaves: targets.targetLeaves,
          message: `Initial tree — ${leafCount} leaves. Deepening toward ~${targets.targetLeaves}…`,
        });
        session.auto_deepen = { enabled: true, deepenCalls: 0, rounds: 0, done: false };
      } else {
        setProgress(session, {
          phase: 'done',
          round: 0,
          deepenCalls: 0,
          targetLeaves: targets.targetLeaves,
          message: 'Shallow tree (auto-deepen off)',
        });
        session.auto_deepen = { enabled: false, deepenCalls: 0, rounds: 0, done: true };
      }

      const fit = attachFit(session, targets);
      const { initProjectRuntime } = await import('@/lib/projectRuntime');
      initProjectRuntime(session as DecompSessionRecord);
      try {
        const { ensureSessionWorkspaceForApi } = await import('@/lib/sessionExecutor');
        await ensureSessionWorkspaceForApi(session as DecompSessionRecord);
      } catch {
        /* workspace created lazily on first leaf */
      }
      setSession(session as DecompSessionRecord);

      return NextResponse.json({
        ok: true,
        session,
        fit,
        summary: session.summary,
        progressive: useProgressive,
        deepening: useProgressive,
        progress: session.progress,
        source,
        degraded: source === 'fallback',
        targets: {
          budgetMinutes: targets.budgetMinutes,
          targetLeaves: targets.targetLeaves,
          maxLeaves: targets.maxLeaves,
          deepenAboveMinutes: targets.deepenAboveMinutes,
          label: targets.label,
        },
      });
    }

    if (action === 'deepen_step') {
      if (!sessionId) {
        return NextResponse.json({ ok: false, error: 'missing_session' }, { status: 400 });
      }
      const session = (await hydrateSession(sessionId)) || getSession(sessionId);
      if (!session) {
        return NextResponse.json({ ok: false, error: 'session_not_found' }, { status: 404 });
      }
      const sessTargets = computeBudgetTargets(
        session.budget_minutes || parseTimeToMinutes(session.timeRequirement)
      );

      // Recover empty/corrupt sessions mid-flight
      if (!session.nodes?.length) {
        const mission = sanitizeMission(session.project || session.project_title || 'Recovered mission');
        const fb = buildFallbackTree(mission, sessTargets);
        const rebuilt = finalizeTree(fb.nodes, sessTargets, mission);
        session.nodes = rebuilt.nodes;
        session.decomp_meta = {
          ...(typeof session.decomp_meta === 'object' && session.decomp_meta
            ? (session.decomp_meta as object)
            : {}),
          source: 'fallback',
          recovered: true,
        };
      }

      const step = await autoDeepenStep(session, sessTargets, {
        round: session.auto_deepen?.rounds ?? 0,
        deepenCalls: session.auto_deepen?.deepenCalls ?? 0,
      });
      session.auto_deepen = {
        enabled: true,
        deepenCalls: step.deepenCalls,
        rounds: step.round,
        done: step.done,
      };
      const fit = attachFit(session, sessTargets);
      if (step.done) {
        setProgress(session, {
          phase: 'done',
          round: step.round,
          deepenCalls: step.deepenCalls,
          targetLeaves: sessTargets.targetLeaves,
          message: `Tree ready — ${fit.leafCount} leaves (${fit.status})`,
        });
      }
      setSession(session);
      return NextResponse.json({
        ok: true,
        session,
        fit,
        summary: session.summary,
        progress: session.progress,
        done: step.done,
        batchSize: step.batchSize,
      });
    }

    if (action === 'deepen') {
      if (!sessionId || !nodeId) {
        return NextResponse.json({ ok: false, error: 'missing_session_or_node' }, { status: 400 });
      }

      const session = (await hydrateSession(sessionId)) || getSession(sessionId);
      if (!session) {
        return NextResponse.json({ ok: false, error: 'session_not_found' }, { status: 404 });
      }

      const parent = findNode(session.nodes, nodeId);
      if (!parent) {
        return NextResponse.json({ ok: false, error: 'node_not_found' }, { status: 404 });
      }

      const sessTargets = computeBudgetTargets(
        session.budget_minutes || parseTimeToMinutes(session.timeRequirement)
      );
      const { leafCount } = summarizeTreeEffort(session.nodes);
      parent._deepenAttempts = false;
      await deepenNode(parent, session, sessTargets, leafCount);
      const fit = attachFit(session, sessTargets);
      setSession(session);

      return NextResponse.json({
        ok: true,
        parentId: nodeId,
        children: parent.children || [],
        session,
        fit,
        summary: session.summary,
      });
    }

    if (action === 'auto_deepen') {
      if (!sessionId) {
        return NextResponse.json({ ok: false, error: 'missing_session' }, { status: 400 });
      }
      const session = (await hydrateSession(sessionId)) || getSession(sessionId);
      if (!session) {
        return NextResponse.json({ ok: false, error: 'session_not_found' }, { status: 404 });
      }
      const sessTargets = computeBudgetTargets(
        session.budget_minutes || parseTimeToMinutes(session.timeRequirement)
      );
      const stats = await autoDeepenTree(session, sessTargets);
      session.auto_deepen = { enabled: true, ...stats };
      const fit = attachFit(session, sessTargets);
      setSession(session);
      return NextResponse.json({ ok: true, session, fit, summary: session.summary, ...stats });
    }

    if (action === 'assign_agent') {
      const { nodeIds, agentId } = body;
      if (!sessionId || !nodeIds || !agentId) {
        return NextResponse.json({ ok: false, error: 'missing_fields' }, { status: 400 });
      }
      const session = (await hydrateSession(sessionId)) || getSession(sessionId);
      if (!session) return NextResponse.json({ ok: false, error: 'session_not_found' }, { status: 404 });

      for (const nid of nodeIds) {
        const node = findNode(session.nodes, nid);
        if (node) {
          node.assignedAgent = agentId;
          node.status = 'running';
        }
      }
      setSession(session);
      return NextResponse.json({ ok: true, session });
    }

    if (action === 'complete') {
      const { result } = body;
      if (!sessionId || !nodeId) {
        return NextResponse.json({ ok: false, error: 'missing_fields' }, { status: 400 });
      }
      const session = (await hydrateSession(sessionId)) || getSession(sessionId);
      if (!session) return NextResponse.json({ ok: false, error: 'session_not_found' }, { status: 404 });

      const node = findNode(session.nodes, nodeId);
      if (node) {
        if (result) node.result = result;
        const { ensureSessionWorkspaceForApi } = await import('@/lib/sessionExecutor');
        const { finalizeLeafCandidate } = await import('@/lib/leafCompletionGates');
        const workspace = await ensureSessionWorkspaceForApi(session);
        const gate = await finalizeLeafCandidate(session, node, workspace, {
          reason: 'manual_complete',
        });
        setSession(session);
        return NextResponse.json({
          ok: gate.passed || Boolean(gate.repaired),
          session,
          validation_passed: gate.passed,
          validation_report: gate.report,
          repaired: gate.repaired,
          repair: gate.repair,
          error: gate.passed || gate.repaired ? undefined : node.validation_feedback,
        });
      }
      setSession(session);
      return NextResponse.json({ ok: true, session });
    }

    if (action === 're_run_branch') {
      if (!sessionId || !nodeId) {
        return NextResponse.json({ ok: false, error: 'missing_fields' }, { status: 400 });
      }
      const session = (await hydrateSession(sessionId)) || getSession(sessionId);
      if (!session) return NextResponse.json({ ok: false, error: 'session_not_found' }, { status: 404 });

      const node = findNode(session.nodes, nodeId);
      if (node) {
        const { resetLeafValidation } = await import('@/lib/leafCompletionGates');
        resetLeafValidation(node);
        node.status = 'pending';
        node.runCount = (node.runCount || 0) + 1;
        node.purpose = node.runCount > 1 ? `quality_improvement_run_${node.runCount}` : undefined;
        node.completedAt = undefined;
        node.last_error = undefined;
      }
      setSession(session);
      return NextResponse.json({ ok: true, session });
    }

    if (action === 'verify') {
      const { output } = body;
      if (!sessionId || !nodeId) {
        return NextResponse.json({ ok: false, error: 'missing_fields' }, { status: 400 });
      }
      const session = (await hydrateSession(sessionId)) || getSession(sessionId);
      if (!session) return NextResponse.json({ ok: false, error: 'session_not_found' }, { status: 404 });
      const node = findNode(session.nodes, nodeId);
      if (!node) return NextResponse.json({ ok: false, error: 'node_not_found' }, { status: 404 });

      if (output) node.result = String(output);

      const softVerifier = async ({ output: out }: { node: any; output: string }) => {
        const verifyPrompt = `You are the SwarmAgents Quality Verifier. 
Review the completed task output below. Determine if it's complete, needs minor fixes, or needs rework.

Task output: ${(out || '').slice(0, 3000)}

Respond with JSON:
{ "verdict": "pass" | "minor_fixes" | "needs_rework", "feedback": "...", "confidence": 0-1 }`;
        const parsed = await callDeepSeek(
          'You are a strict but fair quality verifier.',
          verifyPrompt,
          0.2,
          512
        );
        return {
          verdict: String(parsed?.verdict || 'needs_rework'),
          feedback: String(parsed?.feedback || ''),
          confidence: Number(parsed?.confidence) || 0,
        };
      };

      const { ensureSessionWorkspaceForApi } = await import('@/lib/sessionExecutor');
      const { finalizeLeafCandidate } = await import('@/lib/leafCompletionGates');
      const workspace = await ensureSessionWorkspaceForApi(session);
      const gate = await finalizeLeafCandidate(session, node, workspace, {
        reason: 'manual_verify',
        softVerifier,
      });
      setSession(session);
      return NextResponse.json({
        ok: gate.passed || Boolean(gate.repaired),
        session,
        verification: {
          verdict: gate.passed ? 'pass' : gate.repaired ? 'minor_fixes' : 'needs_rework',
          feedback: node.validation_feedback,
          confidence: gate.passed ? 0.9 : 0.4,
        },
        validation_passed: gate.passed,
        validation_report: gate.report,
        repaired: gate.repaired,
        repair: gate.repair,
      });
    }

    if (action === 'execute_leaves') {
      if (!sessionId) {
        return NextResponse.json({ ok: false, error: 'missing_sessionId' }, { status: 400 });
      }
      const session = (await hydrateSession(sessionId)) || getSession(sessionId);
      if (!session) {
        return NextResponse.json({ ok: false, error: 'session_not_found' }, { status: 404 });
      }
      if (session.paused) {
        return NextResponse.json({
          ok: true,
          session,
          paused: true,
          done: false,
          remaining: -1,
          message: 'Session paused — resume from chat to continue agents',
        });
      }

      const { ensureProjectRuntime } = await import('@/lib/projectRuntime');
      ensureProjectRuntime(session);

      const { executeLeafBatch } = await import('@/lib/sessionExecutor');
      const runtimeBatch = Number((session.runtime as { batchSize?: number } | undefined)?.batchSize);
      const batchSize = Math.min(8, Math.max(1, runtimeBatch || Number(body.batchSize) || 2));
      const stats = await executeLeafBatch(session, batchSize);
      setSession(session);
      const fit = attachFit(session, computeBudgetTargets(session.budget_minutes || 60));

      return NextResponse.json({
        ok: true,
        session,
        fit,
        summary: session.summary,
        runtime: session.runtime,
        ...stats,
      });
    }

    if (action === 'orchestrate_until_done') {
      if (!sessionId) {
        return NextResponse.json({ ok: false, error: 'missing_sessionId' }, { status: 400 });
      }
      let session = (await hydrateSession(sessionId)) || getSession(sessionId);
      if (!session) {
        return NextResponse.json({ ok: false, error: 'session_not_found' }, { status: 404 });
      }

      const { ensureProjectRuntime, executeRoundBudget } = await import('@/lib/projectRuntime');
      ensureProjectRuntime(session);
      const { executeLeafBatch } = await import('@/lib/sessionExecutor');
      const { tickProjectWatcher } = await import('@/lib/projectWatcher');

      const maxRounds = Math.min(
        Number(body.maxRounds) || executeRoundBudget(session),
        5000
      );
      let rounds = 0;
      let lastStats: Record<string, unknown> = {};

      // Continue deepen if tree still shallow relative to target
      const targets = computeBudgetTargets(session.budget_minutes || 60);
      if (session.auto_deepen?.enabled && !session.auto_deepen?.done) {
        const deepen = await autoDeepenStep(session, targets, {
          round: session.auto_deepen.rounds || 0,
          deepenCalls: session.auto_deepen.deepenCalls || 0,
        });
        session.auto_deepen = {
          enabled: true,
          deepenCalls: deepen.deepenCalls,
          rounds: deepen.round,
          done: deepen.done,
        };
      }

      while (rounds < maxRounds) {
        if (session.paused) break;
        rounds++;
        const runtimeBatch = Number(
          (session.runtime as { batchSize?: number } | undefined)?.batchSize
        );
        const batchSize = Math.min(8, Math.max(1, runtimeBatch || Number(body.batchSize) || 2));
        lastStats = await executeLeafBatch(session, batchSize);
        setSession(session);
        const watcher = lastStats.watcher as { pause?: boolean } | undefined;
        if (
          Boolean(lastStats.done) ||
          Boolean(lastStats.terminal) ||
          Boolean(watcher?.pause)
        ) {
          break;
        }
        // Extra watcher tick already inside executeLeafBatch
        if (rounds % 5 === 0) tickProjectWatcher(session);
      }

      const fit = attachFit(session, targets);
      setSession(session);
      return NextResponse.json({
        ok: true,
        session,
        fit,
        summary: session.summary,
        runtime: session.runtime,
        orchestrated_rounds: rounds,
        ...lastStats,
      });
    }

    return NextResponse.json({ ok: false, error: 'unknown_action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
}
