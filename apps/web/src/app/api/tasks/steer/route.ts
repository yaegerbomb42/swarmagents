import { NextRequest, NextResponse } from 'next/server';
import { engineForwardHeaders, requireAuth } from '@/lib/serverAuth';
import { sanitizeUserInput } from '@/lib/decompEngine';
import {
  getSession,
  hydrateSession,
  setSession,
  findNode,
  collectNodeIds,
  ensureConstraints,
  appendSteerLog,
  parseSteerIntent,
  type SteerAction,
  type SteerDirective,
  type SteerStatus,
  type DecompSessionRecord,
} from '@/lib/decompSessions';
export const dynamic = 'force-dynamic';

const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8400';

async function probeEngine(): Promise<boolean> {
  // The engine exposes `/health` (engine_core.py); `/api/health` does not exist.
  try {
    const r = await fetch(`${ENGINE_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Harness run ids are `run-<12 hex>` (engine/harness/runner.py RunRequest). */
function isHarnessRunId(id: unknown): id is string {
  return typeof id === 'string' && /^run-[A-Za-z0-9_-]+$/.test(id);
}

/** Forward a steer note to the durable harness: POST /v1/runs/{id}/steer. */
async function forwardHarnessSteer(
  runId: string,
  text: string,
  headers: Record<string, string>
): Promise<{ ok: boolean; status: number; data?: any; error?: string }> {
  const runApiToken = (process.env.SWARM_API_TOKEN || '').trim();
  const h: Record<string, string> = runApiToken
    ? { ...headers, Authorization: `Bearer ${runApiToken}` }
    : headers;
  try {
    const res = await fetch(`${ENGINE_URL}/v1/runs/${encodeURIComponent(runId)}/steer`, {
      method: 'POST',
      headers: h,
      // `text` is the v2 contract; `instruction` keeps pre-v2 engines working.
      body: JSON.stringify({ text, instruction: text }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok
      ? { ok: true, status: res.status, data }
      : { ok: false, status: res.status, error: String(data?.detail || data?.error || res.statusText) };
  } catch (err: any) {
    return { ok: false, status: 502, error: err?.message || 'engine unreachable' };
  }
}

async function forwardEngineSteer(
  projectId: string,
  message: string,
  action: SteerAction,
  headers: Record<string, string>
): Promise<{ ok: boolean; data?: any }> {
  // Only endpoints that actually exist on the engine (decomposition_server.py):
  // pause/resume. There is no engine `/api/tasks/steer` nor
  // `/api/decomposition/projects/{id}/steer`, so other actions stay local and
  // free text goes through the chat relay.
  const payloads: Array<{ url: string; body: Record<string, unknown> }> = [];
  if (action === 'pause') {
    payloads.push({ url: `${ENGINE_URL}/api/decomposition/projects/${projectId}/pause`, body: {} });
  } else if (action === 'resume') {
    payloads.push({ url: `${ENGINE_URL}/api/decomposition/projects/${projectId}/resume`, body: {} });
  }
  void message;

  for (const p of payloads) {
    try {
      const res = await fetch(p.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(p.body),
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) return { ok: true, data: await res.json() };
    } catch {
      /* try next */
    }
  }
  return { ok: false };
}

/** Chat agent → orchestrator relay for free-form user messages. */
async function relayChatToOrchestrator(
  message: string,
  headers: Record<string, string>,
  context?: { projectId?: string; nodeId?: string; action?: SteerAction; agentId?: string }
): Promise<string | null> {
  const targetAgent = context?.agentId?.trim();
  const prompt = [
    'You are the SwarmAgents chat agent speaking to the user.',
    targetAgent
      ? `The user is directly addressing agent "${targetAgent}". Reply as that agent would — acknowledge their steering and describe what you will change in your own work.`
      : 'You coordinate with the orchestrator and worker agents.',
    'Reply in 1-2 short, friendly sentences. Confirm what you will tell the team.',
    'Do not use jargon like re_decompose, leaf, or steerLog.',
    context?.action && context.action !== 'message'
      ? `Structured action already applied: ${context.action}.`
      : 'Treat this as guidance for the orchestrator.',
    context?.projectId ? `Active project: ${context.projectId}.` : '',
    context?.nodeId ? `User is focused on task: ${context.nodeId}.` : '',
    `User said: ${message}`,
  ]
    .filter(Boolean)
    .join('\n');

  const urls = [`${ENGINE_URL}/chat`]; // engine_core.py; `/api/chat` does not exist
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: prompt,
          agent_id: targetAgent || 'steer_chat',
          model_preference: 'fast',
        }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const text =
        data?.response || data?.content || data?.message || data?.data?.response;
      if (typeof text === 'string' && text.trim()) return text.trim();
    } catch {
      /* try next */
    }
  }
  return null;
}

function makeDirective(
  partial: Omit<SteerDirective, 'id' | 'timestamp'>
): SteerDirective {
  return {
    ...partial,
    id: `steer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
  };
}

function applyLocalAction(
  session: DecompSessionRecord,
  action: SteerAction,
  opts: {
    message?: string;
    nodeId?: string;
    payload?: Record<string, unknown>;
    parentId?: string;
  }
): { status: SteerStatus; affectedNodeIds: string[]; response: string } {
  const { message, nodeId, payload, parentId } = opts;
  const constraints = ensureConstraints(session);

  switch (action) {
    case 'pause': {
      session.paused = true;
      session.status = 'paused';
      const running = collectNodeIds(session.nodes, (n) =>
        ['running', 'executing', 'assigned'].includes(n.status)
      );
      for (const id of running) {
        const n = findNode(session.nodes, id);
        if (n) {
          n._prevStatus = n.status;
          n.status = 'paused';
        }
      }
      return {
        status: 'applied',
        affectedNodeIds: running,
        response: `Paused the team${running.length ? ` (${running.length} tasks on hold)` : ''}. Say when to resume.`,
      };
    }

    case 'resume': {
      session.paused = false;
      session.status = 'active';
      const paused = collectNodeIds(session.nodes, (n) => n.status === 'paused');
      for (const id of paused) {
        const n = findNode(session.nodes, id);
        if (n) {
          n.status = n._prevStatus || 'pending';
          delete n._prevStatus;
        }
      }
      return {
        status: 'applied',
        affectedNodeIds: paused,
        response: `Resumed the team${paused.length ? ` — ${paused.length} tasks are moving again` : ''}.`,
      };
    }

    case 'pause_node': {
      if (!nodeId) {
        return { status: 'rejected', affectedNodeIds: [], response: 'pause_node requires nodeId' };
      }
      const node = findNode(session.nodes, nodeId);
      if (!node) {
        return { status: 'rejected', affectedNodeIds: [], response: `Node ${nodeId} not found` };
      }
      node._prevStatus = node.status;
      node.status = 'paused';
      return {
        status: 'applied',
        affectedNodeIds: [nodeId],
        response: `I paused “${node.label || nodeId}” for the team.`,
      };
    }

    case 'resume_node': {
      if (!nodeId) {
        return { status: 'rejected', affectedNodeIds: [], response: 'Tell me which task to resume.' };
      }
      const node = findNode(session.nodes, nodeId);
      if (!node) {
        return { status: 'rejected', affectedNodeIds: [], response: `I couldn't find that task (${nodeId}).` };
      }
      node.status = node._prevStatus || 'pending';
      delete node._prevStatus;
      return {
        status: 'applied',
        affectedNodeIds: [nodeId],
        response: `Resumed “${node.label || nodeId}”.`,
      };
    }

    case 'cancel_node': {
      if (!nodeId) {
        return { status: 'rejected', affectedNodeIds: [], response: 'Tell me which task to cancel.' };
      }
      const node = findNode(session.nodes, nodeId);
      if (!node) {
        return { status: 'rejected', affectedNodeIds: [], response: `I couldn't find that task (${nodeId}).` };
      }
      node.status = 'failed';
      node.result = node.result || 'Cancelled by steering directive';
      return {
        status: 'applied',
        affectedNodeIds: [nodeId],
        response: `Cancelled “${node.label || nodeId}”.`,
      };
    }

    case 're_decompose': {
      if (!nodeId) {
        return {
          status: 'rejected',
          affectedNodeIds: [],
          response: 're_decompose requires nodeId',
        };
      }
      const node = findNode(session.nodes, nodeId);
      if (!node) {
        return { status: 'rejected', affectedNodeIds: [], response: `Node ${nodeId} not found` };
      }
      node.needs_deeper = true;
      node._deepenAttempts = false;
      node.status = 'pending';
      // Mark for deepen — actual deepen is triggered by client or auto_deepen action
      return {
        status: 'applied',
        affectedNodeIds: [nodeId],
        response: `Marked ${nodeId} for re-decomposition. Call deepen/auto_deepen to expand.`,
      };
    }

    case 'inject_leaf':
    case 'spawn_leaf': {
      const label = String(payload?.label || message || 'Injected task').slice(0, 200);
      const parent =
        (parentId && findNode(session.nodes, parentId)) ||
        (nodeId && findNode(session.nodes, nodeId)) ||
        session.nodes[0];
      if (!parent) {
        return {
          status: 'rejected',
          affectedNodeIds: [],
          response: 'No parent available to inject under',
        };
      }
      const leaf = {
        id: `${parent.id}-inj-${Date.now().toString(36)}`,
        type: 'task',
        label,
        description: String(payload?.description || label),
        acceptance_criteria: [
          String(payload?.acceptance || `Done when: ${label}`),
        ],
        priority: String(payload?.priority || 'high'),
        effort_minutes: Number(payload?.effort_minutes) || 5,
        needs_deeper: false,
        depends_on: Array.isArray(payload?.depends_on) ? payload!.depends_on : [],
        agent_class: String(payload?.agent_class || 'grunt'),
        model_tier: String(payload?.model_tier || 'grunt'),
        tools: Array.isArray(payload?.tools) ? payload!.tools : ['edit'],
        status: 'pending',
        runCount: 0,
        parentId: parent.id,
        depth: (parent.depth || 0) + 1,
        children: [],
        injected: true,
      };
      parent.children = parent.children || [];
      parent.children.push(leaf);
      if (parent.type === 'task') parent.type = 'area';
      return {
        status: 'applied',
        affectedNodeIds: [leaf.id, parent.id],
        response: `Added “${label}” for the team under that task.`,
      };
    }

    case 'skip_leaf': {
      if (!nodeId) {
        return { status: 'rejected', affectedNodeIds: [], response: 'Tell me which leaf to skip.' };
      }
      const node = findNode(session.nodes, nodeId);
      if (!node) {
        return { status: 'rejected', affectedNodeIds: [], response: `Couldn't find ${nodeId}.` };
      }
      node.status = 'failed';
      node.skipped = true;
      node.result = String(payload?.reason || message || 'Skipped via steer');
      return {
        status: 'applied',
        affectedNodeIds: [nodeId],
        response: `Skipped “${node.label || nodeId}”.`,
      };
    }

    case 'merge_nodes': {
      const keepId = String(payload?.keep_id || nodeId || '');
      const absorbId = String(payload?.absorb_id || '');
      if (!keepId || !absorbId) {
        return {
          status: 'rejected',
          affectedNodeIds: [],
          response: 'merge_nodes needs keep_id and absorb_id',
        };
      }
      const keep = findNode(session.nodes, keepId);
      const absorb = findNode(session.nodes, absorbId);
      if (!keep || !absorb) {
        return { status: 'rejected', affectedNodeIds: [], response: 'One of those nodes is missing.' };
      }
      keep.description = `${keep.description || keep.label}\n\nMerged: ${absorb.label}`.slice(0, 4000);
      absorb.status = 'failed';
      absorb.merged_into = keepId;
      return {
        status: 'applied',
        affectedNodeIds: [keepId, absorbId],
        response: `Merged “${absorb.label || absorbId}” into “${keep.label || keepId}”.`,
      };
    }

    case 'set_quality': {
      const bar = String(payload?.qualityBar || 'high').toLowerCase() as
        | 'low'
        | 'medium'
        | 'high'
        | 'strict';
      constraints.qualityBar = ['low', 'medium', 'high', 'strict'].includes(bar)
        ? bar
        : 'high';
      return {
        status: 'applied',
        affectedNodeIds: [],
        response: `Told validators to use a ${constraints.qualityBar} quality bar.`,
      };
    }

    case 'prefer': {
      const text = String(payload?.text || message || '').trim();
      if (!text) {
        return { status: 'rejected', affectedNodeIds: [], response: 'What should the team prefer?' };
      }
      constraints.prefer = [...constraints.prefer.filter((p) => p !== text), text].slice(-20);
      return {
        status: 'applied',
        affectedNodeIds: [],
        response: `Noted — I'll tell the orchestrator to prefer: ${text.slice(0, 120)}`,
      };
    }

    case 'avoid': {
      const text = String(payload?.text || message || '').trim();
      if (!text) {
        return { status: 'rejected', affectedNodeIds: [], response: 'What should the team avoid?' };
      }
      constraints.avoid = [...constraints.avoid.filter((p) => p !== text), text].slice(-20);
      return {
        status: 'applied',
        affectedNodeIds: [],
        response: `Got it — team will avoid: ${text.slice(0, 120)}`,
      };
    }

    case 'message':
    default: {
      // Soft directive stored as prefer-style note
      const text = (message || '').trim();
      if (text) {
        constraints.prefer = [
          ...constraints.prefer.filter((p) => !p.startsWith('[steer]')),
          `[steer] ${text.slice(0, 200)}`,
        ].slice(-20);
      }
      return {
        status: 'applied',
        affectedNodeIds: [],
        response: text
          ? `Got it — I'll pass that to the orchestrator: "${text.slice(0, 140)}"`
          : 'I need a short message to pass along.',
      };
    }
  }
}

/**
 * POST /api/tasks/steer
 * Structured steering for live swarm / decomp sessions.
 *
 * Body:
 * {
 *   action?: SteerAction,          // default: parse from message
 *   message?: string,
 *   project_id?: string,           // engine project id
 *   sessionId?: string,            // decomp session id
 *   nodeId?: string,
 *   parentId?: string,             // for inject_leaf
 *   payload?: object
 * }
 */
export async function POST(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth.ok !== true) return auth.response;

  try {
    const body = await request.json();
    const forwardHeaders = engineForwardHeaders(request);
    const {
      message: rawMessage = '',
      project_id,
      sessionId,
      nodeId,
      parentId,
      payload,
      agentId,
    } = body;
    const message = sanitizeUserInput(rawMessage);

    // 0) Durable harness runs: one real endpoint, honest status. The note is
    //    "sent" until the run stream reports steer.applied.
    const harnessRunId = [body.runId, body.run_id, project_id, sessionId].find(isHarnessRunId);
    if (harnessRunId) {
      const text = String(message || body.text || '').trim();
      if (!text) {
        return NextResponse.json({ ok: false, error: 'message is required' }, { status: 400 });
      }
      const r = await forwardHarnessSteer(harnessRunId, text, forwardHeaders);
      return NextResponse.json(
        {
          ok: r.ok,
          runId: harnessRunId,
          status: r.ok ? 'sent' : 'rejected',
          response: r.ok
            ? 'Sent to the run. It is applied at the next step boundary.'
            : `Engine refused the steer (${r.status}): ${r.error}`,
          engine: r.data,
        },
        { status: r.ok ? 200 : r.status >= 400 && r.status < 600 ? r.status : 502 }
      );
    }

    let action: SteerAction = body.action;
    if (!action) {
      if (!message?.trim()) {
        return NextResponse.json(
          { error: 'message or action is required', ok: false },
          { status: 400 }
        );
      }
      const parsed = parseSteerIntent(message);
      action = parsed.action;
      body.nodeId = body.nodeId || parsed.nodeId;
      body.payload = body.payload || parsed.payload;
    }

    const engineOnline = await probeEngine();
    const sid = sessionId || (String(project_id || '').startsWith('session-') ? project_id : null);
    const session = sid ? ((await hydrateSession(sid)) || getSession(sid)) : undefined;

    // 1) Apply locally when we have a decomp session
    let local: { status: SteerStatus; affectedNodeIds: string[]; response: string } | null =
      null;
    if (session) {
      local = applyLocalAction(session, action, {
        message,
        nodeId: nodeId || body.nodeId,
        payload: payload || body.payload,
        parentId,
      });
      setSession(session);

      // Auto-trigger deepen when re_decompose applied
      if (action === 're_decompose' && local.status === 'applied' && (nodeId || body.nodeId)) {
        // Client can call deepen; we flag needs_deeper already
      }
    }

    // 2) Forward structured steers to engine when online
    let engineResult: { ok: boolean; data?: any } = { ok: false };
    if (engineOnline && project_id) {
      engineResult = await forwardEngineSteer(
        project_id,
        message || action,
        action,
        forwardHeaders
      );
    }

    // 2b) Free-text / guidance → chat agent talks to orchestrator
    let chatRelay: string | null = null;
    if (message?.trim() && (action === 'message' || !engineResult.ok)) {
      chatRelay = await relayChatToOrchestrator(message, forwardHeaders, {
        projectId: project_id || sid || undefined,
        nodeId: nodeId || body.nodeId,
        action,
        agentId,
      });
    }

    // 3) Resolve final status — never fake "queued" as success when we applied locally
    let status: SteerStatus;
    let response: string;
    let affectedNodeIds: string[] = local?.affectedNodeIds || [];

    if (local?.status === 'rejected') {
      status = 'rejected';
      response = local.response;
    } else if (local && engineResult.ok) {
      status = 'applied';
      response = chatRelay || local.response;
    } else if (local) {
      status = engineOnline && action !== 'message' ? 'partial' : 'applied';
      response =
        chatRelay ||
        (engineOnline && action !== 'message'
          ? `${local.response} (team sync pending — I'll keep trying)`
          : local.response);
    } else if (engineResult.ok) {
      status = 'applied';
      response =
        chatRelay ||
        engineResult.data?.message ||
        engineResult.data?.response ||
        `Passed to the orchestrator.`;
    } else if (chatRelay) {
      status = 'applied';
      response = chatRelay;
    } else if (!session && !project_id) {
      status = 'rejected';
      response = 'Start an objective first, then chat here to steer the team.';
    } else if (!session && project_id && !engineOnline) {
      status = 'queued';
      response = `The engine is offline right now — I queued that for the team.`;
    } else {
      status = 'queued';
      response = chatRelay || `Queued for the orchestrator. The team will pick it up shortly.`;
    }

    const directive = makeDirective({
      action,
      message: message || undefined,
      nodeId: nodeId || body.nodeId,
      payload: payload || body.payload,
      status,
      affectedNodeIds,
      response,
      engineOnline,
    });

    if (session) {
      appendSteerLog(session, directive);
      setSession(session);
    }

    return NextResponse.json({
      ok: status === 'applied' || status === 'partial',
      status,
      action,
      response,
      affectedNodeIds,
      engineOnline,
      directive,
      session: session || undefined,
      constraints: session?.constraints,
      timestamp: directive.timestamp,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'Steering failed', detail: String(error), status: 'rejected' },
      { status: 500 }
    );
  }
}

/** GET /api/tasks/steer?sessionId=… — recent steer log + constraints */
export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('sessionId');
  if (!sessionId) {
    return NextResponse.json({ ok: false, error: 'sessionId required' }, { status: 400 });
  }
  const session = (await hydrateSession(sessionId)) || getSession(sessionId);
  if (!session) {
    return NextResponse.json({ ok: false, error: 'session_not_found' }, { status: 404 });
  }
  const engineOnline = await probeEngine();
  return NextResponse.json({
    ok: true,
    engineOnline,
    paused: Boolean(session.paused),
    constraints: session.constraints || { prefer: [], avoid: [], qualityBar: 'medium' },
    steerLog: session.steerLog || [],
  });
}
