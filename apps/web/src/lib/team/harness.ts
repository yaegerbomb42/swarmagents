/**
 * Team Mode — harness contract + the default engine-backed implementation.
 *
 * The runner only knows this interface, which is what makes the fake-harness
 * tests meaningful: they drive the real planner → parallel workers → review →
 * merge pipeline without an LLM or a network.
 */

import { executeTask, type ExecutionStep } from '@/lib/agentEngine';
import { gatewayChatUrl } from '@/lib/providerRouter';
import { getAgentRoleById, type AgentRole } from '@/lib/agentRoles';
import { mergeLaneIntoRun } from './workspace';
import { estimateTokens } from './providerRotation';
import type {
  AgentResult,
  MergeOutcome,
  ReviewVerdict,
  TeamPlanItem,
  TeamSettings,
  TeamTaskDraft,
} from './types';
import type { TeamRoute } from './providerRotation';

export interface PlanInput {
  prompt: string;
  runId: string;
  settings: TeamSettings;
  routes: TeamRoute[];
}

export interface ExecuteInput {
  runId: string;
  task: TeamPlanItem;
  role: AgentRole;
  tools: string[];
  workspace: string;
  attempt: number;
  route: TeamRoute | null;
  onAction: (action: string) => void;
  signal?: AbortSignal;
}

export interface ReviewInput {
  task: TeamPlanItem;
  result: AgentResult;
  attempt: number;
  route: TeamRoute | null;
}

export interface MergeInput {
  runId: string;
  task: TeamPlanItem;
  result: AgentResult;
  workspace: string;
}

export interface TeamHarness {
  readonly id: string;
  plan(input: PlanInput): Promise<TeamTaskDraft[]>;
  execute(input: ExecuteInput): Promise<AgentResult>;
  review(input: ReviewInput): Promise<ReviewVerdict>;
  merge(input: MergeInput): Promise<MergeOutcome>;
}

// ── Default harness ──────────────────────────────────────────────────

const CHAT_MODEL = process.env.NEXT_PUBLIC_ENGINE_CHAT_MODEL || 'DeepSeek-V4-Flash';

async function chat(system: string, user: string, maxTokens = 1400): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60_000);
  try {
    const res = await fetch(gatewayChatUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        max_tokens: maxTokens,
      }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`planner/reviewer model ${res.status}: ${await res.text().catch(() => '')}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonBlock<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'));
  if (start < 0 || end <= start) throw new Error('model did not return JSON');
  return JSON.parse(body.slice(start, end + 1)) as T;
}

const PLANNER_SYSTEM = `You are the Planner on a SwarmAgents team.
Break the user's goal into 2–4 independent tasks that can run in parallel.
Return ONLY JSON: [{"title": "...", "detail": "...", "roleId": "..."}]
roleId must be one of: implementer, qa-engineer, researcher, debugger, documentation-writer, devops-engineer, security-auditor.
No prose, no markdown fence.`;

const REVIEWER_SYSTEM = `You are the Reviewer on a SwarmAgents team.
Decide whether the agent's result satisfies the task. Return ONLY JSON:
{"approved": boolean, "note": "one sentence"}
Approve only when the result actually addresses the task. When you reject, the note must say exactly what to fix.`;

export class EngineTeamHarness implements TeamHarness {
  readonly id = 'engine';

  async plan(input: PlanInput): Promise<TeamTaskDraft[]> {
    const raw = await chat(PLANNER_SYSTEM, `GOAL: ${input.prompt}\nProduce at most ${input.settings.maxTasks} tasks.`);
    const parsed = parseJsonBlock<{ title?: string; detail?: string; roleId?: string }[]>(raw);
    const drafts = (Array.isArray(parsed) ? parsed : [])
      .map((t) => ({
        title: String(t?.title || '').trim(),
        detail: String(t?.detail || '').trim(),
        roleId: String(t?.roleId || '').trim(),
      }))
      .filter((t) => t.title)
      .slice(0, input.settings.maxTasks);
    if (drafts.length < 2) throw new Error('planner returned fewer than 2 usable tasks');
    return drafts;
  }

  async execute(input: ExecuteInput): Promise<AgentResult> {
    const { task, role, tools, workspace, route } = input;
    const taskText = [
      `TASK: ${task.title}`,
      task.detail ? `DETAIL: ${task.detail}` : '',
      `YOUR ROLE: ${role.name} — ${role.responsibility}`,
      `ALLOWED TOOLS: ${tools.join(', ') || 'none'}`,
      `WORKING FOLDER (write every file under this absolute path): ${workspace}`,
    ]
      .filter(Boolean)
      .join('\n');

    let last = '';
    const files = new Set<string>();
    const state = await executeTask(
      `team-${input.runId}-${task.id}-a${input.attempt}`,
      taskText,
      route ? `Provider ${route.provider} · model ${route.model}` : '',
      (step: ExecutionStep) => {
        if (step.result?.output) last = step.result.output;
        if (step.tool === 'file_write' && step.result?.output) {
          const m = /Wrote \d+ bytes to (.+)$/.exec(step.result.output);
          if (m?.[1]) files.add(m[1].trim());
        }
        if (step.reasoning) input.onAction(step.reasoning.slice(0, 140));
        else if (step.tool) input.onAction(`${step.tool}…`);
      },
      3,
      24,
    );

    const ok = state.status === 'completed';
    const summary = state.finalResult || last || (ok ? 'completed' : state.error || 'no result');
    return {
      ok,
      summary: summary.slice(0, 4000),
      files: [...files],
      tokens: estimateTokens(taskText) + estimateTokens(summary),
      ...(ok ? {} : { error: state.error || `agent ${state.status}` }),
    };
  }

  async review(input: ReviewInput): Promise<ReviewVerdict> {
    try {
      const raw = await chat(
        REVIEWER_SYSTEM,
        `TASK: ${input.task.title}\n${input.task.detail}\n\nRESULT:\n${input.result.summary}\n\nFILES: ${input.result.files.join(', ') || 'none'}`,
        300,
      );
      const parsed = parseJsonBlock<{ approved?: boolean; note?: string }>(raw);
      return {
        approved: Boolean(parsed?.approved),
        note: String(parsed?.note || (parsed?.approved ? 'accepted' : 'rejected without a note')).slice(0, 400),
      };
    } catch {
      // No reviewer model reachable: fall back to a deterministic check and say so.
      const approved = input.result.ok && input.result.summary.trim().length > 0;
      return {
        approved,
        note: approved
          ? 'heuristic review (reviewer model unreachable): non-empty result'
          : 'heuristic review (reviewer model unreachable): empty result',
      };
    }
  }

  async merge(input: MergeInput): Promise<MergeOutcome> {
    const files = await mergeLaneIntoRun({
      runId: input.runId,
      files: input.result.files,
      summary: `${input.task.title}\n\n${input.result.summary}`,
      agentId: `${input.task.id}`,
    });
    return { merged: files.length > 0, files, note: `merged ${files.length} file(s)` };
  }
}

/** Roles eligible for worker lanes, in assignment order. */
export const WORKER_ROLE_POOL = [
  'implementer',
  'qa-engineer',
  'researcher',
  'debugger',
  'documentation-writer',
  'devops-engineer',
  'security-auditor',
];

export function workerRoleFor(index: number, requested?: string): AgentRole {
  const byId = requested ? getAgentRoleById(requested) : undefined;
  if (byId && WORKER_ROLE_POOL.includes(byId.id)) return byId;
  const id = WORKER_ROLE_POOL[index % WORKER_ROLE_POOL.length];
  return getAgentRoleById(id) || getAgentRoleById('implementer')!;
}

/** Tools a lane may use: its role tools, minus anything the user disallowed. */
export function toolsForRole(role: AgentRole, settings: TeamSettings): string[] {
  const allowed = settings.allowedTools;
  if (!allowed || !allowed.length) return role.tools;
  const set = new Set(allowed);
  return role.tools.filter((t) => set.has(t));
}