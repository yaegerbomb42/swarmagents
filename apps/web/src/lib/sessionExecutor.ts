/**
 * Execute decomp session leaves using providers/roles from Settings.
 */

import { deepseekChat, isDeepSeekConfigured } from '@/lib/deepseek';
import { loadProvidersStore, type StoredProvider } from '@/lib/providerStore';
import { type DecompSessionRecord } from '@/lib/decompSessions';
import { templateByType } from '@/lib/providerTemplates';
import {
  finalizeLeafCandidate,
  leafBatchTerminalStats,
} from '@/lib/leafCompletionGates';
import { repairSortBoost, sessionRepairStats } from '@/lib/leafRepairLoop';
import { searchWeb } from '@/lib/tools/webBrowser';
import path from 'path';
import { promises as fs } from 'fs';

const ENGINE_URL = (process.env.ENGINE_URL || 'http://localhost:8410').replace(/\/$/, '');

const CLASS_TO_ROLE: Record<string, string> = {
  architect: 'architect',
  orchestrator: 'architect',
  specialist: 'implementer',
  frontend: 'implementer',
  backend: 'implementer',
  grunt: 'implementer',
  qa: 'verifier',
  research: 'researcher',
  researcher: 'researcher',
};

export function collectLeaves(nodes: any[]): any[] {
  const leaves: any[] = [];
  const walk = (list: any[]) => {
    for (const n of list || []) {
      const kids = n.children || [];
      if (!kids.length && (n.type === 'task' || n.type === 'leaf' || !n.type)) {
        leaves.push(n);
      } else if (kids.length) {
        walk(kids);
      } else {
        leaves.push(n);
      }
    }
  };
  walk(nodes || []);
  return leaves;
}

function roleForNode(node: any): string {
  if (node.runtimePreferredRole) return String(node.runtimePreferredRole);
  const cls = String(node.agent_class || node.tags?.[0] || 'grunt').toLowerCase();
  return CLASS_TO_ROLE[cls] || 'implementer';
}

async function pickProvider(_roleId?: string): Promise<StoredProvider | null> {
  const store = await loadProvidersStore();
  const enabled = store.providers.filter((p) => {
    if (!p.enabled) return false;
    const tmpl = templateByType(p.type);
    if (tmpl && !tmpl.needsKey) return Boolean(p.endpoint);
    return Boolean(p.apiKey || (!tmpl?.needsKey && p.endpoint));
  });
  if (!enabled.length) {
    const anyLocal = store.providers.filter((p) => p.enabled && p.endpoint);
    if (!anyLocal.length) return null;
    return anyLocal[0];
  }

  // Prefer explicit role → provider/model bindings when present
  try {
    const {
      findBindingForHint,
      pickBoundOption,
      preferModelOnProvider,
    } = await import('@/lib/roleBindings');
    const binding = findBindingForHint(_roleId, store.roleBindings || []);
    if (binding?.options?.length) {
      const picked = pickBoundOption(binding, enabled);
      if (picked) return preferModelOnProvider(picked.provider, picked.model);
    }
  } catch {
    /* bindings optional */
  }

  // Pure provider frequency meters: weight by allocation.percent only
  const weighted: Array<{ provider: StoredProvider; weight: number }> = [];
  for (const alloc of store.allocations) {
    const provider = enabled.find((p) => p.id === alloc.providerId);
    if (!provider) continue;
    const w = Math.max(0, Number(alloc.percent) || 0);
    if (w > 0) weighted.push({ provider, weight: w });
  }
  if (!weighted.length) return enabled[0] || null;

  const total = weighted.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const item of weighted) {
    r -= item.weight;
    if (r <= 0) return item.provider;
  }
  return weighted[weighted.length - 1]?.provider || enabled[0] || null;
}

/** Sum of soft concurrency caps across enabled providers (for seat batching). */
export async function providerConcurrencyBudget(): Promise<number> {
  const store = await loadProvidersStore();
  let sum = 0;
  for (const p of store.providers) {
    if (!p.enabled) continue;
    sum += Math.max(1, Number(p.quota?.maxConcurrency) || 2);
  }
  return Math.max(1, sum || 4);
}

export async function chatWithProvider(
  provider: StoredProvider,
  system: string,
  user: string
): Promise<string | null> {
  return callProviderChat(provider, system, user);
}

async function callProviderChat(
  provider: StoredProvider,
  system: string,
  user: string
): Promise<string | null> {
  const model = provider.models[0] || 'default';
  const base = (provider.endpoint || '').replace(/\/$/, '');
  const style =
    provider.type === 'anthropic'
      ? 'anthropic'
      : provider.type === 'gemini'
        ? 'gemini'
        : provider.type === 'ollama'
          ? 'ollama'
          : provider.type === 'azure' || provider.type === 'azure-foundry'
            ? 'azure'
            : provider.type === 'cohere'
              ? 'cohere'
              : 'openai';

  try {
    if (style === 'anthropic') {
      if (!provider.apiKey || !base) return null;
      const res = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': provider.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          system,
          messages: [{ role: 'user', content: user }],
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const text = data?.content?.[0]?.text;
      return typeof text === 'string' && text.trim() ? text.trim() : null;
    }

    if (style === 'gemini') {
      if (!provider.apiKey || !base) return null;
      const url = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(provider.apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: `${system}\n\n${user}` }],
            },
          ],
          generationConfig: { temperature: 0.35, maxOutputTokens: 2048 },
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      return typeof text === 'string' && text.trim() ? text.trim() : null;
    }

    if (style === 'ollama') {
      if (!base) return null;
      // Prefer OpenAI-compat; fall back to native /api/chat
      const openaiUrl = `${base}/v1/chat/completions`;
      let res = await fetch(openaiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.35,
          stream: false,
        }),
        signal: AbortSignal.timeout(45_000),
      }).catch(() => null);
      if (!res?.ok) {
        res = await fetch(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            stream: false,
          }),
          signal: AbortSignal.timeout(45_000),
        });
      }
      if (!res.ok) return null;
      const data = await res.json();
      const text =
        data?.choices?.[0]?.message?.content || data?.message?.content || data?.response;
      return typeof text === 'string' && text.trim() ? text.trim() : null;
    }

    if (style === 'cohere') {
      if (!provider.apiKey || !base) return null;
      const res = await fetch(`${base}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const text = data?.message?.content?.[0]?.text || data?.text;
      return typeof text === 'string' && text.trim() ? text.trim() : null;
    }

    // OpenAI-compatible (+ Azure with api-key header)
    if (!base) return null;
    const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.apiKey) {
      if (style === 'azure') headers['api-key'] = provider.apiKey;
      else headers.Authorization = `Bearer ${provider.apiKey}`;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.35,
        max_tokens: 2048,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text =
      data?.choices?.[0]?.message?.content ||
      data?.content?.[0]?.text ||
      data?.response;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}

async function callEngineChat(system: string, user: string): Promise<string | null> {
  const urls = [`${ENGINE_URL}/chat`, `${ENGINE_URL}/api/chat`];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `${system}\n\n${user}`,
          agent_id: 'session_worker',
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const text = data?.response || data?.content || data?.message;
      if (typeof text === 'string' && text.trim()) return text.trim();
    } catch {
      /* next */
    }
  }
  return null;
}

function buildContext(session: DecompSessionRecord): string {
  const parts: string[] = [`Project: ${session.project}`];
  if (session.mission?.constraints?.length) {
    parts.push(`Constraints: ${session.mission.constraints.join('; ')}`);
  }
  const prefer = session.constraints?.prefer || [];
  const avoid = session.constraints?.avoid || [];
  if (prefer.length) parts.push(`Prefer: ${prefer.join('; ')}`);
  if (avoid.length) parts.push(`Avoid: ${avoid.join('; ')}`);
  const meta = session as DecompSessionRecord & {
    github_repo?: string;
    attached_files?: string[];
    file_context?: string;
    _leafPromptExtras?: string;
  };
  if (meta.github_repo) parts.push(`GitHub: ${meta.github_repo}`);
  if (meta.attached_files?.length) parts.push(`Files: ${meta.attached_files.join(', ')}`);
  if (meta.file_context) parts.push(`File context:\n${meta.file_context.slice(0, 6000)}`);
  if (meta._leafPromptExtras) parts.push(meta._leafPromptExtras);
  return parts.join('\n');
}

async function hamiltonianDecide(payload: Record<string, unknown>): Promise<{
  optimal_action: string;
  thinking_style: string;
  confidence: number;
  optimal_sequence: string[];
  candidate_actions?: Array<{ action: string; confidence: number; energy_delta: number; phase: string }>;
  suggested_params?: Record<string, unknown>;
  phase?: string;
} | null> {
  try {
    const res = await fetch(`${ENGINE_URL}/leaf/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.ok || !data.optimal_action) return null;
    return {
      optimal_action: String(data.optimal_action),
      thinking_style: String(data.thinking_style || 'think_deep'),
      confidence: Number(data.confidence || 0),
      optimal_sequence: Array.isArray(data.optimal_sequence)
        ? data.optimal_sequence.map(String)
        : [],
      candidate_actions: Array.isArray(data.candidate_actions) ? data.candidate_actions : [],
      suggested_params: data.suggested_params || {},
      phase: data.phase || 'execution',
    };
  } catch {
    return null;
  }
}

async function hamiltonianFeedback(payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${ENGINE_URL}/leaf/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* best-effort learning */
  }
}

function parseChatFencedFiles(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const header = (m[1] || '').trim();
    const body = m[2] || '';
    let rel = '';
    const parts = header.split(/\s+/).filter(Boolean);
    for (const p of parts) {
      if (p.includes('/') || /\.(js|ts|tsx|py|md|json|txt|css|html)$/i.test(p)) {
        rel = p.replace(/^\.?\/+/, '');
        break;
      }
    }
    if (!rel && parts.length === 1 && parts[0].includes('.')) rel = parts[0];
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) continue;
    out[rel] = body.replace(/\n$/, '');
  }
  return out;
}

function leafLooksDone(content: string, node: any): boolean {
  const lower = content.toLowerCase();
  if (/\b(LEAF_DONE|TASK_COMPLETE|acceptance (met|satisfied))\b/i.test(content)) return true;
  if (node.acceptance_criteria?.length) {
    const hits = node.acceptance_criteria.filter((c: string) =>
      lower.includes(String(c).toLowerCase().slice(0, 24))
    );
    if (hits.length >= Math.ceil(node.acceptance_criteria.length * 0.6)) return true;
  }
  return content.trim().length > 400 && /\b(done|complete|implemented|delivered)\b/i.test(lower);
}

async function callLeafLlm(
  provider: StoredProvider | null,
  system: string,
  user: string
): Promise<string | null> {
  let content: string | null = null;
  if (provider) content = await callProviderChat(provider, system, user);
  if (!content) content = await callEngineChat(system, user);
  if (!content && isDeepSeekConfigured()) {
    try {
      content = await deepseekChat(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        { temperature: 0.35, maxTokens: 2048 }
      );
    } catch {
      return null;
    }
  }
  return content;
}

/** Shared path both dashboard + swarm-engine can see (Docker volume). */
function workspaceRoot(): string {
  return (
    process.env.SWARM_WORKSPACE_ROOT ||
    process.env.ENGINE_WORKSPACE_ROOT ||
    path.join(process.cwd(), '.data', 'workspaces')
  );
}

async function ensureSessionWorkspace(session: DecompSessionRecord): Promise<string> {
  if (typeof session.workspace_path === 'string' && session.workspace_path) {
    const existing = String(session.workspace_path);
    await fs.mkdir(existing, { recursive: true });
    return existing;
  }
  const dir = path.join(workspaceRoot(), session.id);
  await fs.mkdir(path.join(dir, 'deliverables'), { recursive: true });
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  const readme = path.join(dir, 'README.md');
  try {
    await fs.access(readme);
  } catch {
    const goal = String(
      (session as { goal?: string }).goal ||
        (session.summary as { goal?: string } | undefined)?.goal ||
        session.project ||
        session.id
    );
    await fs.writeFile(
      readme,
      `# SwarmAgents workspace\n\nSession: \`${session.id}\`\n\n## Goal\n\n${goal}\n\nAgents write real files here via tool use (file_write / shell_exec).\n`,
      'utf8'
    );
  }
  session.workspace_path = dir;
  return dir;
}

/** Public alias for session create / API routes. */
export async function ensureSessionWorkspaceForApi(
  session: DecompSessionRecord
): Promise<string> {
  return ensureSessionWorkspace(session);
}

async function runLeafViaEngine(
  session: DecompSessionRecord,
  node: any,
  workspace: string,
  maxSteps: number,
  roleId: string,
  provider: StoredProvider | null
): Promise<{
  ok: boolean;
  agentRole: string;
  providerName?: string;
  error?: string;
  repaired?: boolean;
} | null> {
  const leaves = collectLeaves(session.nodes);
  const completed = leaves.filter((n) => n.status === 'completed').length;
  const pending = leaves.filter((n) => !['completed', 'failed'].includes(n.status)).length;
  const providerName = provider?.name || provider?.id;
  const continueCount = Number(node.continue_count) || 0;
  const smallModel = detectSmallModel(provider);
  try {
    const llm =
      provider && (provider.endpoint || provider.apiKey)
        ? {
            endpoint: provider.endpoint || '',
            api_key: provider.apiKey || '',
            model: provider.models?.[0] || 'deepseek-chat',
            type: provider.type || 'openai',
          }
        : undefined;
    const res = await fetch(`${ENGINE_URL}/leaf/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_id: node.id,
        task_label: node.label || node.description || node.id,
        description: [node.description, buildContext(session), node._promptExtras]
          .filter(Boolean)
          .join('\n\n'),
        acceptance: node.acceptance_criteria || [
          'Deliverable file(s) exist in workspace',
          'Acceptance criteria addressed',
        ],
        workspace_path: workspace,
        max_steps: maxSteps,
        priority: node.priority === 'critical' ? 10 : node.priority === 'high' ? 8 : 5,
        effort_minutes: Number(node.effort_minutes) || 5,
        pending_tasks: pending,
        completed_tasks: completed,
        time_remaining_sec: Math.max(
          60,
          (Number(session.budget_minutes) || 60) * 60
        ),
        use_hamiltonian: true,
        llm,
        small_model: smallModel,
        continue_count: continueCount,
      }),
      signal: AbortSignal.timeout(Math.min(600_000, 45_000 * Math.max(4, maxSteps))),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.ok && !data?.result) return null;

    const pulses = data.pulses || [];
    const last = pulses[pulses.length - 1];
    node.last_pulse = last
      ? {
          action: last.action,
          thinking_style: last.thinking_style,
          confidence: last.confidence,
          sequence: last.sequence,
          step: last.step,
        }
      : node.last_pulse;
    node.step_history = [
      ...(Array.isArray(node.step_history) ? node.step_history : []),
      ...pulses.map((p: any) => ({
        step: p.step,
        action: p.action,
        thinking_style: p.thinking_style,
        confidence: p.confidence,
        preview: p.action,
      })),
    ].slice(-80);
    const prevFiles = Array.isArray(node.files_written) ? node.files_written : [];
    node.files_written = Array.from(
      new Set([...prevFiles, ...(data.files_written || [])])
    );
    node.workspace_path = data.workspace || workspace;
    node.trajectory_steps = Number(node.trajectory_steps || 0) + Number(data.steps || 0);
    node.result = JSON.stringify(
      {
        ok: data.ok,
        finished: data.finished,
        steps: data.steps,
        continue_eligible: data.continue_eligible,
        continue_count: continueCount,
        files_written: node.files_written,
        notes: data.result?.notes || data.result?.approach,
        artifacts: data.result?.artifacts,
      },
      null,
      2
    ).slice(0, 12000);

    // Accumulate session trajectory counter
    const rt = session.runtime as { trajectorySteps?: number } | undefined;
    if (rt && typeof rt === 'object') {
      rt.trajectorySteps = Number(rt.trajectorySteps || 0) + Number(data.steps || 0);
    }

    if (data.continue_eligible && !data.finished) {
      node.continue_count = continueCount + 1;
      node.status = 'pending'; // re-queue for another micro-trajectory
      node.quality_score = 0.55;
      return { ok: true, agentRole: roleId, providerName };
    }

    const candidate =
      Boolean(data.finished) ||
      Boolean(data.candidate_complete) ||
      (Array.isArray(data.files_written) && data.files_written.length > 0) ||
      Boolean(data.ok);
    if (candidate) {
      node.continue_count = continueCount;
      node.quality_score = data.finished ? 0.9 : 0.7;
      const gate = await finalizeLeafCandidate(session, node, workspace, {
        reason: 'engine_finish',
      });
      if (gate.repaired) {
        return {
          ok: true,
          agentRole: roleId,
          providerName,
          error: undefined,
          repaired: true,
        };
      }
      return {
        ok: gate.passed,
        agentRole: roleId,
        providerName,
        error: gate.passed ? undefined : node.validation_feedback || 'Gate suite failed',
      };
    }

    node.status = 'pending';
    node.continue_count = continueCount + 1;
    return {
      ok: false,
      agentRole: roleId,
      providerName,
      error: data.result?.notes || 'Leaf engine run incomplete',
    };
  } catch {
    return null;
  }
}

export async function reconcileGateReceipts(session: DecompSessionRecord, workspace: string): Promise<void> {
  try {
    const { promises: fsp } = await import('fs');
    const pathMod = await import('path');
    for (const leaf of collectLeaves(session.nodes)) {
      if (leaf.status === 'completed' || leaf.status === 'failed') continue;
      const receiptPath = pathMod.join(workspace, '.swarm', `leaf-${leaf.id}.json`);
      try {
        const receipt = JSON.parse(await fsp.readFile(receiptPath, 'utf8'));
        if (receipt?.validation_passed === true || receipt?.validation?.passed === true) {
          leaf.status = 'completed';
          leaf.validation_passed = true;
          if (receipt.validation) leaf.validation = receipt.validation;
        }
      } catch {
        /* no receipt yet */
      }
    }
  } catch {
    /* non-fatal */
  }
}

function detectSmallModel(provider: StoredProvider | null): boolean {
  if (!provider) return true;
  const name = `${provider.type || ''} ${provider.models?.[0] || ''} ${provider.name || ''}`.toLowerCase();
  if (
    /gpt-4|claude-3-5|claude-4|opus|sonnet-4|gemini-2\.5-pro|deepseek-v[34]|qwen2\.5-72|70b|72b/.test(
      name
    )
  ) {
    return false;
  }
  // Azure Foundry cloud deployments are not local tiny models.
  if (provider.type === 'azure' || provider.type === 'azure-foundry') return false;
  // Local / ollama / small cloud defaults → small-model path
  if (/ollama|lmstudio|7b|8b|9b|3b|1\.5b|mini|nano|haiku|tiny/.test(name)) return true;
  if (/flash/.test(name) && !/deepseek/.test(name)) return true;
  return true; // default: assume small — safer for long trajectories
}

async function runLeaf(
  session: DecompSessionRecord,
  node: any
): Promise<{ ok: boolean; agentRole: string; providerName?: string; error?: string; repaired?: boolean }> {
  const seatTitle = String(node.assignedAgent || node.seatTitle || roleForNode(node));
  const provider = await pickProvider(seatTitle);
  const runtimeSteps = Number((session.runtime as { leafStepBudget?: number } | undefined)?.leafStepBudget);
  const smallModel = detectSmallModel(provider);
  const maxSteps = Math.max(
    smallModel ? 8 : 14,
    Math.min(
      24,
      runtimeSteps || Math.max(smallModel ? 8 : 14, Math.min(18, Number(node.effort_minutes) || 8))
    )
  );

  node.status = 'running';
  node.assignedAgent = seatTitle;
  node.assignedProvider = provider?.name || provider?.id || 'default';
  if (!Array.isArray(node.step_history)) node.step_history = [];
  node.last_pulse = null;

  const workspace = await ensureSessionWorkspace(session);
  const seatId = String(node.assignedSeatId || '');
  if (seatId) {
    const { markSeatWorking } = await import('@/lib/seatSpawner');
    markSeatWorking(session, seatId);
  }

  const engineResult = await runLeafViaEngine(
    session,
    node,
    workspace,
    maxSteps,
    seatTitle,
    provider
  );

  if (seatId) {
    const { markSeatIdle } = await import('@/lib/seatSpawner');
    markSeatIdle(session, seatId);
  }

  // Post blackboard pulse after engine attempt
  try {
    const { postBlackboard } = await import('@/lib/sessionBlackboard');
    if ((node.files_written || []).length) {
      await postBlackboard(workspace, {
        kind: 'file_ptr',
        seatId: seatId || seatTitle,
        leafId: node.id,
        text: `Wrote ${(node.files_written || []).slice(0, 3).join(', ')}`,
        path: node.files_written[0],
      });
    } else if (engineResult && !engineResult.ok) {
      await postBlackboard(workspace, {
        kind: 'blocker',
        seatId: seatId || seatTitle,
        leafId: node.id,
        text: engineResult.error || 'Leaf incomplete',
      });
    }
  } catch {
    /* ignore */
  }

  // Prefer full tool path when it produced files or finished
  if (engineResult?.ok) return engineResult;

  // Fallback: chat-only multi-step if engine leaf runner unavailable or incomplete
  if (engineResult && !engineResult.ok) {
    node.status = 'running';
  }
  const roleId = seatTitle;
  const leaves = collectLeaves(session.nodes);
  const completed = leaves.filter((n) => n.status === 'completed').length;
  const failed = leaves.filter((n) => n.status === 'failed').length;
  const pending = leaves.filter((n) => !['completed', 'failed'].includes(n.status)).length;
  const baseCtx = buildContext(session);
  const chunks: string[] = [];
  let lastAction: string | undefined;
  let lastSuccess: boolean | undefined;
  let acceptanceMet = 0;

  for (let step = 0; step < maxSteps; step++) {
    const pulse = await hamiltonianDecide({
      task_id: node.id,
      task_label: node.label || node.description || node.id,
      task_description: node.description || '',
      step_index: step,
      max_steps: maxSteps,
      acceptance_met_ratio: acceptanceMet,
      last_action: lastAction,
      last_success: lastSuccess,
      priority: node.priority === 'critical' ? 10 : node.priority === 'high' ? 8 : 5,
      effort_minutes: Number(node.effort_minutes) || 5,
      pending_tasks: pending,
      completed_tasks: completed,
      failed_tasks: failed,
      time_remaining_sec: Math.max(
        60,
        (Number(session.budget_minutes) || 60) * 60 * (1 - step / maxSteps)
      ),
      time_consumed_ratio: step / maxSteps,
    });

    const action = pulse?.optimal_action || (step === 0 ? 'plan' : 'iterate');
    const style = pulse?.thinking_style || 'think_deep';
    const confidence = pulse?.confidence ?? 0;
    const sequence = pulse?.optimal_sequence || [];

    node.last_pulse = { action, thinking_style: style, confidence, sequence, step };
    node.assigned_worker_id = roleId;

    let webContext = '';
    const isWebTask =
      (node.tools || []).some((t: string) => t === 'browser' || t === 'search') ||
      roleId === 'researcher' ||
      roleId === 'browser-agent' ||
      node.agent_class === 'researcher';

    if (isWebTask && step === 0) {
      try {
        const query = node.label || node.description || session.project;
        const searchHits = await searchWeb(query, 3);
        if (searchHits.length) {
          webContext = `\n[Live Web Search Context]:\n${searchHits
            .map((h) => `- ${h.title} (${h.url}): ${h.snippet}`)
            .join('\n')}`;
        }
      } catch {
        /* non-fatal */
      }
    }

    const system = [
      `You are the SwarmAgents ${roleId} agent working ONE leaf task.`,
      `Hamiltonian optimal action for this step: ${action}`,
      `Thinking style: ${style}`,
      sequence.length ? `Suggested next moves: ${sequence.join(' → ')}` : '',
      `Write concrete deliverable content. Workspace: ${workspace}`,
      node.watcher_urgency === 'ship_mvp'
        ? 'WATCHER: Time is low — ship the smallest acceptable MVP for this leaf now.'
        : '',
      `If the leaf acceptance criteria are fully met, end with the line: LEAF_DONE`,
    ]
      .filter(Boolean)
      .join('\n');

    const user = [
      baseCtx,
      webContext,
      node._promptExtras || '',
      `Task id: ${node.id}`,
      `Task: ${node.label || node.description || node.id}`,
      node.description ? `Details: ${node.description}` : '',
      node.acceptance_criteria?.length
        ? `Acceptance:\n- ${node.acceptance_criteria.join('\n- ')}`
        : '',
      node.deliverable_path ? `Write toward: ${node.deliverable_path}` : '',
      `Step ${step + 1}/${maxSteps}`,
      chunks.length ? `Prior step outputs:\n${chunks.slice(-2).join('\n---\n').slice(0, 4000)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const content = await callLeafLlm(provider, system, user);
    if (!content) {
      if (step === 0) {
        node.status = 'pending';
        return {
          ok: false,
          agentRole: roleId,
          providerName: provider?.name,
          error: 'No LLM provider available — configure agents in Settings',
        };
      }
      break;
    }

    chunks.push(content.slice(0, 6000));
    // Prefer fenced file payloads over dumping chat into deliverables/*.md
    try {
      const parsed = parseChatFencedFiles(content);
      const written: string[] = Array.isArray(node.files_written) ? [...node.files_written] : [];
      for (const [rel, body] of Object.entries(parsed)) {
        if (!rel || rel.includes('..') || path.isAbsolute(rel)) continue;
        const abs = path.join(workspace, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, body, 'utf8');
        if (!written.includes(rel)) written.push(rel);
      }
      if (written.length) {
        node.files_written = written;
      } else {
        const outPath = path.join(workspace, 'deliverables', `${node.id || 'leaf'}.md`);
        await fs.mkdir(path.dirname(outPath), { recursive: true });
        await fs.writeFile(outPath, chunks.join('\n\n---\n\n'), 'utf8');
        node.files_written = [`deliverables/${node.id || 'leaf'}.md`];
      }

      // YOLO Mode: mark complete immediately when files are written
      const isYoloMode =
        (session as any).execution_mode === 'yolo' ||
        (session as any).yolo_mode === true;
      if (isYoloMode && node.files_written.length > 0) {
        node.status = 'completed';
        node.validation_passed = true;
        node.quality_score = 1.0;
        return {
          ok: true,
          agentRole: roleId,
          providerName: provider?.name,
          error: undefined,
        };
      }
    } catch {
      /* ignore */
    }

    const done = leafLooksDone(content, node);
    lastAction = action;
    lastSuccess = true;
    acceptanceMet = done ? 1 : Math.min(0.95, acceptanceMet + 1 / maxSteps);
    node.step_history.push({
      step,
      action,
      thinking_style: style,
      confidence,
      preview: content.slice(0, 240),
    });
    await hamiltonianFeedback({
      task_id: node.id,
      action,
      thinking_style: style,
      trajectory: sequence,
      reward: done ? 1.0 : 0.55 + acceptanceMet * 0.3,
      step_index: step,
      priority: node.priority === 'critical' ? 10 : 5,
      effort_minutes: Number(node.effort_minutes) || 5,
      pending_tasks: pending,
      completed_tasks: completed,
      failed_tasks: failed,
      time_consumed_ratio: (step + 1) / maxSteps,
      acceptance_met_ratio: acceptanceMet,
    });
    if (done) break;
  }

  if (!chunks.length) {
    node.status = 'pending';
    return {
      ok: false,
      agentRole: roleId,
      providerName: provider?.name,
      error: 'No LLM provider available — configure agents in Settings',
    };
  }

  node.result = chunks.join('\n\n---\n\n').slice(0, 12000);
  node.quality_score = 0.85;
  if (!leafLooksDone(node.result, node)) {
    node.status = 'pending';
    return {
      ok: false,
      agentRole: roleId,
      providerName: provider?.name,
      error: 'Chat trajectory incomplete — acceptance not met',
    };
  }
  const gate = await finalizeLeafCandidate(session, node, workspace, {
    reason: 'chat_completion',
  });
  if (gate.repaired) {
    return { ok: true, agentRole: roleId, providerName: provider?.name, repaired: true };
  }
  return {
    ok: gate.passed,
    agentRole: roleId,
    providerName: provider?.name,
    error: gate.passed ? undefined : node.validation_feedback || 'Gate suite failed',
  };
}

/**
 * Execute up to `batchSize` pending leaves. Mutates session in place.
 * Project watcher ticks after the batch to keep pace and QA leaf output.
 */
export async function executeLeafBatch(
  session: DecompSessionRecord,
  batchSize = 2
): Promise<{
  executed: Array<{
    id: string;
    ok: boolean;
    agentRole: string;
    providerName?: string;
    error?: string;
    repaired?: boolean;
  }>;
  remaining: number;
  done: boolean;
  terminal: boolean;
  completed: number;
  failed: number;
  total: number;
  repaired: number;
  repairing: number;
  seats?: Array<{
    id: string;
    title: string;
    status: string;
    ownsPaths?: string[];
    leafIds?: string[];
  }>;
  blackboardCount?: number;
  heatmapTop?: string[];
  watcher?: {
    pause: boolean;
    retried: string[];
    events: Array<{ at: number; level: string; message: string; leafId?: string }>;
    timeRemainingSec: number;
    paceOk: boolean;
  };
  organizer?: {
    applied: number;
    spawned: number;
    skipped: number;
    deepened: number;
    merged: number;
    events: Array<{ at: number; level: string; message: string }>;
  };
}> {
  if (session.paused) {
    const leaves = collectLeaves(session.nodes);
    const stats = leafBatchTerminalStats(leaves);
    const rs = sessionRepairStats(leaves);
    return {
      executed: [],
      repaired: 0,
      repairing: rs.repairing,
      ...stats,
    };
  }

  const runtimeBatch = Number((session.runtime as { batchSize?: number } | undefined)?.batchSize);

  // Company swarm: heatmap → blackboard → context → organizer → pure seat spawn
  const workspace = await ensureSessionWorkspace(session);
  const { tickOrganizer } = await import('@/lib/treeOrganizer');
  await tickOrganizer(session, workspace);

  // Re-collect after organizer may have spawned/deepened/skipped
  const leaves = collectLeaves(session.nodes);

  const { loadSessionBlackboard, selectRelevantPosts, formatBlackboardForPrompt } = await import(
    '@/lib/sessionBlackboard'
  );
  const { buildCodebaseHeatmap, topHotspots, heatmapHintForPrompt } = await import(
    '@/lib/codebaseHeatmap'
  );
  const { loadProjectContext, sliceContextForSeat, mergeBlackboardIntoContext, attachContextToSession } =
    await import('@/lib/projectContext');
  const { ensureSeats, getSeats } = await import('@/lib/seatSpawner');

  const bbPosts = await loadSessionBlackboard(session, workspace);
  const heat = await buildCodebaseHeatmap(workspace, session, bbPosts);
  const hotspots = topHotspots(heat, 10);
  let ctx = await loadProjectContext(workspace, session);
  ctx = await mergeBlackboardIntoContext(workspace, ctx, bbPosts);
  attachContextToSession(session, ctx);

  const seats = ensureSeats(session, {
    hotspots,
    blackboardHints: bbPosts
      .filter((p) => p.kind === 'blocker' || p.kind === 'decision')
      .slice(-5)
      .map((p) => p.text.slice(0, 80)),
  });

  // Refresh ownership map from seats
  for (const seat of seats) {
    for (const p of seat.ownsPaths) ctx.ownership[p] = seat.title;
  }
  await (await import('@/lib/projectContext')).saveProjectContext(workspace, ctx);

  const concBudget = await providerConcurrencyBudget();
  const pending = leaves
    .filter((n) => n.status !== 'completed' && n.status !== 'failed' && n.status !== 'running')
    .sort((a, b) => {
      const ra = repairSortBoost(a);
      const rb = repairSortBoost(b);
      if (ra !== rb) return ra - rb;
      const ca = Number(a.continue_count) || 0;
      const cb = Number(b.continue_count) || 0;
      if (ca > 0 && cb === 0) return -1;
      if (cb > 0 && ca === 0) return 1;
      const ua = a.watcher_urgency === 'ship_mvp' ? 0 : 1;
      const ub = b.watcher_urgency === 'ship_mvp' ? 0 : 1;
      return ua - ub;
    });
  // Cap runaway continuations — terminal failure (never force completed)
  for (const n of pending) {
    if ((Number(n.continue_count) || 0) >= 80) {
      n.result = String(n.result || '') + '\n[max continuations reached]';
      n.validation_feedback = 'execution_limit_exceeded';
      n.validation_passed = false;
      n.status = 'failed';
      n.quality_score = 0.3;
      n.last_error = 'execution_limit_exceeded';
    }
  }

  const desired = Math.min(
    Math.max(1, runtimeBatch || batchSize),
    Math.max(1, concBudget),
    Math.max(1, seats.filter((s) => s.status !== 'retired').length || batchSize)
  );
  const batch = pending.slice(0, desired);
  const executed: Array<{
    id: string;
    ok: boolean;
    agentRole: string;
    providerName?: string;
    error?: string;
    repaired?: boolean;
  }> = [];
  let repaired = 0;

  const runOne = async (leaf: any) => {
    const seat = getSeats(session).find((s) => s.leafIds.includes(leaf.id));
    const relevant = selectRelevantPosts(bbPosts, {
      leafLabel: String(leaf.label || leaf.description || ''),
      ownsPaths: seat?.ownsPaths || [],
      limit: 6,
    });
    const repairExtra = leaf.last_repair_brief
      ? `ACTIVE GATE REPAIR:\n${String(leaf.last_repair_brief).slice(0, 1200)}`
      : '';
    let worldExtra = '';
    try {
      const { worldModelPromptSlice } = await import('@/lib/sessionWorldModel');
      worldExtra = await worldModelPromptSlice(workspace);
    } catch {
      /* optional */
    }
    const extras = [
      seat
        ? sliceContextForSeat(ctx, {
            ownsPaths: seat.ownsPaths,
            seatTitle: seat.title,
            blackboard: relevant,
          })
        : '',
      formatBlackboardForPrompt(relevant),
      heatmapHintForPrompt(heat, 5),
      seat ? `You are agent "${seat.title}". Tools preferred: ${seat.tools.join(', ')}.` : '',
      repairExtra,
      worldExtra,
    ]
      .filter(Boolean)
      .join('\n\n');
    leaf._promptExtras = extras;
    if (seat) {
      leaf.assignedSeatId = seat.id;
      leaf.assignedAgent = seat.title;
    }
    const result = await runLeaf(session, leaf);
    delete leaf._promptExtras;
    return { id: leaf.id, ...result };
  };

  const settled = await Promise.all(batch.map((leaf) => runOne(leaf)));
  for (const result of settled) {
    if (result.repaired) repaired += 1;
    executed.push(result);
  }

  const markParents = (nodes: any[]) => {
    for (const n of nodes || []) {
      if (n.children?.length) {
        markParents(n.children);
        const kids = n.children as any[];
        const allDone = kids.every(
          (c) => c.status === 'completed' && c.validation_passed !== false
        );
        const anyFailed = kids.some((c) => c.status === 'failed');
        if (allDone) {
          n.status = 'completed';
          n.validation_passed = true;
        } else if (anyFailed && kids.every((c) => c.status === 'completed' || c.status === 'failed')) {
          n.status = 'failed';
          n.validation_passed = false;
        }
      }
    }
  };

  // Reconcile from gate receipts — keeps tree honest if in-memory status lagged.
  try {
    const { promises: fsp } = await import('fs');
    const pathMod = await import('path');
    for (const leaf of collectLeaves(session.nodes)) {
      if (leaf.status === 'completed' || leaf.status === 'failed') continue;
      const receiptPath = pathMod.join(workspace, '.swarm', `leaf-${leaf.id}.json`);
      try {
        const receipt = JSON.parse(await fsp.readFile(receiptPath, 'utf8'));
        if (receipt?.validation_passed === true || receipt?.validation?.passed === true) {
          leaf.status = 'completed';
          leaf.validation_passed = true;
          if (receipt.validation) leaf.validation = receipt.validation;
        }
      } catch {
        /* no receipt yet */
      }
    }
  } catch {
    /* non-fatal */
  }

  markParents(session.nodes);

  // Drain tree mutations leaf agents queued during this batch, then pace again
  const org = await tickOrganizer(session, workspace);

  const { tickProjectWatcher } = await import('@/lib/projectWatcher');
  const watch = tickProjectWatcher(session);

  const allLeaves = collectLeaves(session.nodes);
  const { remaining, completed, failed, total, done, terminal } = leafBatchTerminalStats(allLeaves);
  const rs = sessionRepairStats(allLeaves);

  if (watch.pause) {
    session.status = 'paused';
  } else if (done) {
    session.status = 'completed';
  } else if (terminal && failed > 0) {
    session.status = 'failed';
  } else {
    session.status = 'executing';
  }

  return {
    executed,
    remaining,
    done,
    terminal,
    completed,
    failed,
    total,
    repaired,
    repairing: rs.repairing,
    seats: getSeats(session).filter((s) => s.status !== 'retired'),
    blackboardCount: bbPosts.length,
    heatmapTop: hotspots.slice(0, 5),
    watcher: {
      pause: watch.pause,
      retried: watch.retried,
      events: watch.events,
      timeRemainingSec: watch.timeRemainingSec,
      paceOk: watch.paceOk,
    },
    organizer: {
      applied: org.applied,
      spawned: org.spawned.length,
      skipped: org.skipped.length,
      deepened: org.deepened.length,
      merged: org.merged.length,
      events: org.events.slice(-12),
    },
  };
}
