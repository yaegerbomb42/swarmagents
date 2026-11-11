'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Brain, GitBranch, Zap, Bot,
  Shield, CheckCircle, Loader2, AlertTriangle,
  Layers, Sparkles, Play,
  X, Terminal, RefreshCw,
  Globe, Database, Download, Pause, Square,
} from 'lucide-react';
import { decompositionApi, type DecompositionApiError } from '@/lib/decompositionApi';
import { TaskType, DeliverableType, type TaskNode } from '@/types/decomposition';
import PaywallPrompt from '@/components/billing/PaywallPrompt';
import { extractInsufficientCredits, isPaymentRequiredError } from '@/lib/billingClient';
import { estimateRunCredits, hasSufficientBalance } from '@/lib/executionEstimate';
import { MODEL_PRICES } from '@/lib/modelPricing';
import { useBalance, requestBalanceRefresh } from '@/hooks/useBalance';

/** Default model used for pre-flight estimates (matches engine default). */
const ESTIMATE_MODEL = MODEL_PRICES['DeepSeek-V4-Flash'] ? 'DeepSeek-V4-Flash' : Object.keys(MODEL_PRICES)[0];
/** How long to poll balance after returning from Stripe checkout before giving up. */
const TOPUP_POLL_TIMEOUT_MS = 60_000;
const TOPUP_POLL_INTERVAL_MS = 3_000;

interface PaywallState {
  creditsRequired?: number;
  creditsAvailable?: number;
  /** 'preflight' = run hadn't started; 'engine' = API 402; 'leaf' = a node failed mid-run */
  origin: 'preflight' | 'engine' | 'leaf';
  /** Estimated credits for the whole run (preflight origin only). */
  estimatedRunCredits?: number;
}

const INSUFFICIENT_CREDITS_RE = /insufficient[_ ]credits|payment.?required|\b402\b/i;

/** True when a task/leaf failure looks like an engine debit refusal. */
export function isInsufficientCreditsFailure(errorText: string | undefined): boolean {
  return !!errorText && INSUFFICIENT_CREDITS_RE.test(errorText);
}

// ─── Types ──────────────────────────────────────────────────────────

export interface SubTask {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'paused';
  priority: string;
  agent_class: string;
  depends_on: string[];
  result?: string;
  error?: string;
  agent_id?: string;
}

export interface DecomposeResult {
  originalTask: string;
  subtasks: SubTask[];
  count: number;
  estimated_minutes?: number;
  complexity?: string;
  model?: string;
  fallback?: boolean;
}

export interface AgentBrief {
  id: string;
  name: string;
  status: string;
  active_tasks: number;
  tasks_completed: number;
  success_rate: number;
}

// ─── Agent class config ─────────────────────────────────────────────

const AGENT_CLASS_CONFIG: Record<string, { icon: React.ElementType; color: string; bg: string; border: string }> = {
  orchestrator: { icon: Brain, color: 'text-cyan-400', bg: 'bg-cyan-500/10', border: 'border-cyan-500/25' },
  architect: { icon: Layers, color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/25' },
  backend: { icon: Database, color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/25' },
  frontend: { icon: Globe, color: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/25' },
  specialist: { icon: Zap, color: 'text-pink-400', bg: 'bg-pink-500/10', border: 'border-pink-500/25' },
  qa: { icon: Shield, color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/25' },
  grunt: { icon: Terminal, color: 'text-white/50', bg: 'bg-white/[0.03]', border: 'border-white/[0.08]' },
};

const STATUS_NODE: Record<string, { border: string; bg: string; pulse: string }> = {
  running: { border: 'border-cyan-500/40', bg: 'bg-cyan-500/[0.04]', pulse: 'shadow-[0_0_20px_rgba(0,245,255,0.08)]' },
  completed: { border: 'border-emerald-500/30', bg: 'bg-emerald-500/[0.03]', pulse: '' },
  failed: { border: 'border-red-500/30', bg: 'bg-red-500/[0.03]', pulse: '' },
  blocked: { border: 'border-amber-500/30', bg: 'bg-amber-500/[0.03]', pulse: '' },
  pending: { border: 'border-white/[0.05]', bg: 'bg-white/[0.01]', pulse: '' },
};

// ─── Engine → UI state machine ──────────────────────────────────────
// Engine TaskStatus values are mapped onto the UI's 5 visual states.

type UiNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused';

export const ENGINE_STATUS_MAP: Record<string, UiNodeStatus> = {
  pending: 'pending',
  ready: 'pending',
  blocked: 'pending',
  decomposing: 'running',
  assigned: 'running',
  executing: 'running',
  validating: 'running',
  running: 'running',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'failed',
};

// Exported for unit tests — engine→UI state machine contract.
export function engineToUiStatus(status: string | undefined): UiNodeStatus {
  return ENGINE_STATUS_MAP[(status || '').toLowerCase()] ?? 'pending';
}

function extractResultText(node: TaskNode): string | undefined {
  const out = node.output as Record<string, unknown> | null | undefined;
  if (!out) return undefined;
  const candidate = out.result ?? out.text ?? out.content ?? out.output;
  if (typeof candidate === 'string' && candidate.trim()) return candidate;
  if (Object.keys(out).length) {
    try {
      return JSON.stringify(out, null, 2).slice(0, 4000);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Map an engine TaskTree (Record<id, TaskNode>) onto the flat SubTask list. */
// ─── Component-level test seam — allows vitest to stub the singleton API. ──
export const __orchestratorApi = { api: decompositionApi };

function treeToSubTasks(tree: { nodes: Record<string, TaskNode>; root_node_id?: string }): SubTask[] {
  const nodes = Object.values(tree.nodes ?? {});
  return nodes
    .filter((n) => n && n.id && n.id !== tree.root_node_id && n.type !== TaskType.ROOT)
    .map((n: TaskNode): SubTask => {
      const meta = (n.metadata || {}) as Record<string, unknown>;
      const agentClass =
        (typeof meta.agent_class === 'string' && meta.agent_class) ||
        (typeof meta.task_type === 'string' && meta.task_type) ||
        (n.tags && n.tags[0]) ||
        'grunt';
      const titleSrc = (n.description || n.path || n.id).trim();
      return {
        id: n.id,
        title: titleSrc.length > 90 ? `${titleSrc.slice(0, 87)}…` : titleSrc || n.id,
        description: n.description || '',
        status: engineToUiStatus(n.status),
        priority: String(n.priority ?? 'medium'),
        agent_class: agentClass,
        depends_on: Array.isArray(n.dependencies) ? n.dependencies : [],
        result: extractResultText(n),
        error: n.last_error || undefined,
        agent_id: n.assigned_worker_id ?? undefined,
      };
    });
}

// ─── Auto Tree Layout ───────────────────────────────────────────────

interface LayoutNode {
  task: SubTask;
  level: number;
  x: number;
  y: number;
  width: number;
  height: number;
  column: number;
}

function computeLevels(tasks: SubTask[]): Map<string, number> {
  const levels = new Map<string, number>();
  const taskMap = new Map(tasks.map(t => [t.id, t]));

  function getLevel(id: string): number {
    if (levels.has(id)) return levels.get(id)!;
    const task = taskMap.get(id);
    if (!task || task.depends_on.length === 0) {
      levels.set(id, 0);
      return 0;
    }
    const maxDep = Math.max(...task.depends_on.map(d => getLevel(d)));
    levels.set(id, maxDep + 1);
    return maxDep + 1;
  }

  tasks.forEach(t => getLevel(t.id));
  return levels;
}

function buildLayout(tasks: SubTask[], containerWidth: number): LayoutNode[] {
  if (tasks.length === 0) return [];
  const levels = computeLevels(tasks);
  const maxLevel = Math.max(...Array.from(levels.values()));

  // Group by level
  const byLevel = new Map<number, SubTask[]>();
  tasks.forEach(t => {
    const l = levels.get(t.id) ?? 0;
    if (!byLevel.has(l)) byLevel.set(l, []);
    byLevel.get(l)!.push(t);
  });

  const NODE_W = 200;
  const NODE_H = 90;
  const GAP_X = 16;
  const GAP_Y = 40;
  const PAD = 20;
  const LEVEL_PAD_Y = 60;

  const result: LayoutNode[] = [];
  let currentY = 0;

  for (let lvl = 0; lvl <= maxLevel; lvl++) {
    const levelTasks = byLevel.get(lvl) ?? [];
    const totalW = levelTasks.length * (NODE_W + GAP_X) - GAP_X;
    let startX = Math.max(PAD, (containerWidth - totalW) / 2);

    if (totalW > containerWidth - PAD * 2) {
      // Wrap into multiple rows within this level
      const perRow = Math.max(1, Math.floor((containerWidth - PAD * 2) / (NODE_W + GAP_X)));
      levelTasks.forEach((task, idx) => {
        const row = Math.floor(idx / perRow);
        const col = idx % perRow;
        const rowTotal = Math.min(perRow, levelTasks.length - row * perRow) * (NODE_W + GAP_X) - GAP_X;
        const rowStart = Math.max(PAD, (containerWidth - rowTotal) / 2);
        result.push({
          task,
          level: lvl,
          x: rowStart + col * (NODE_W + GAP_X),
          y: currentY + row * (NODE_H + GAP_Y),
          width: NODE_W,
          height: NODE_H,
          column: idx,
        });
      });
      currentY += Math.ceil(levelTasks.length / perRow) * (NODE_H + GAP_Y) + LEVEL_PAD_Y;
    } else {
      levelTasks.forEach((task, idx) => {
        result.push({
          task,
          level: lvl,
          x: startX + idx * (NODE_W + GAP_X),
          y: currentY,
          width: NODE_W,
          height: NODE_H,
          column: idx,
        });
      });
      currentY += NODE_H + LEVEL_PAD_Y;
    }
  }

  return result;
}

// ─── SVG Connections ────────────────────────────────────────────────

function SvgConnections({ layout, containerRef }: { layout: LayoutNode[]; containerRef: React.RefObject<HTMLDivElement | null> }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const layoutMap = useMemo(() => new Map(layout.map(n => [n.task.id, n])), [layout]);

  const redraw = useCallback(() => {
    const svg = svgRef.current;
    const container = containerRef.current;
    if (!svg || !container) return;

    svg.innerHTML = '';
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `<filter id="glow-line"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
    svg.appendChild(defs);

    const totalH = (layout.length > 0 ? Math.max(...layout.map(n => n.y + n.height)) : 400) + 40;
    svg.setAttribute('height', String(totalH));

    layout.forEach(node => {
      node.task.depends_on.forEach(depId => {
        const from = layoutMap.get(depId);
        const to = layoutMap.get(node.task.id);
        if (!from || !to) return;

        const x1 = from.x + from.width / 2;
        const y1 = from.y + from.height;
        const x2 = to.x + to.width / 2;
        const y2 = to.y;
        const cy1 = y1 + (y2 - y1) * 0.4;
        const cy2 = y2 - (y2 - y1) * 0.4;
        const d = `M ${x1} ${y1} C ${x1} ${cy1}, ${x2} ${cy2}, ${x2} ${y2}`;

        const isComplete = node.task.status === 'completed' && from.task.status === 'completed';
        const isRunning = node.task.status === 'running' || from.task.status === 'running';
        const stroke = isComplete ? '#00ff9f' : isRunning ? '#ff6b35' : '#4d9fff';
        const glow = isComplete ? 'rgba(0,255,159,0.3)' : isRunning ? 'rgba(255,107,53,0.3)' : 'rgba(77,159,255,0.3)';
        const pathId = `p-${depId}-${node.task.id}`;

        const g = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        g.setAttribute('d', d); g.setAttribute('fill', 'none');
        g.setAttribute('stroke', glow); g.setAttribute('stroke-width', '4');
        g.setAttribute('opacity', '0.2'); g.style.filter = 'blur(4px)';
        svg.appendChild(g);

        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('id', pathId); p.setAttribute('d', d);
        p.setAttribute('fill', 'none'); p.setAttribute('stroke', stroke);
        p.setAttribute('stroke-width', '1.5'); p.setAttribute('opacity', isComplete ? '0.5' : '0.7');
        svg.appendChild(p);

        if (!isComplete) {
          const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          dot.setAttribute('r', '2.5'); dot.setAttribute('fill', stroke);
          dot.style.filter = `drop-shadow(0 0 4px ${stroke})`;
          const anim = document.createElementNS('http://www.w3.org/2000/svg', 'animateMotion');
          anim.setAttribute('dur', `${1.5 + Math.random() * 2}s`);
          anim.setAttribute('repeatCount', 'indefinite');
          anim.setAttribute('keyPoints', '0;1'); anim.setAttribute('keyTimes', '0;1');
          anim.setAttribute('calcMode', 'linear');
          const mpath = document.createElementNS('http://www.w3.org/2000/svg', 'mpath');
          mpath.setAttributeNS('http://www.w3.org/1999/xlink', 'href', `#${pathId}`);
          anim.appendChild(mpath); dot.appendChild(anim); svg.appendChild(dot);
        }
      });
    });
  }, [layout, layoutMap, containerRef]);

  useEffect(() => {
    redraw();
    const timer = setTimeout(redraw, 200);
    const h = () => setTimeout(redraw, 150);
    window.addEventListener('resize', h);
    return () => { window.removeEventListener('resize', h); clearTimeout(timer); };
  }, [redraw]);

  return (
    <svg
      ref={svgRef}
      className="absolute inset-0 w-full pointer-events-none z-0"
      style={{ height: (layout.length > 0 ? Math.max(...layout.map(n => n.y + n.height)) : 400) + 40 }}
    />
  );
}

// ─── Detail Panel ──────────────────────────────────────────────────

function NodeDetailPanel({ task, onClose }: { task: SubTask | null; onClose: () => void }) {
  if (!task) return null;
  const cfg = AGENT_CLASS_CONFIG[task.agent_class] || AGENT_CLASS_CONFIG.grunt;

  return (
    <motion.div
      initial={{ x: 320, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 320, opacity: 0 }}
      className="fixed right-0 top-0 h-full w-[320px] bg-[#06061a] border-l border-white/[0.06] z-50 overflow-y-auto shadow-2xl"
    >
      <div className="flex items-center justify-between p-4 border-b border-white/[0.06]">
        <span className="text-[9px] font-mono uppercase tracking-[0.2em] text-cyan-500/60">Node Detail</span>
        <button onClick={onClose} className="text-white/30 hover:text-white/60 transition-colors">
          <X size={14} />
        </button>
      </div>

      <div className="p-4 space-y-4">
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${cfg.bg} ${cfg.border} border`}>
            <cfg.icon size={16} className={cfg.color} />
          </div>
          <div>
            <div className="text-sm font-semibold text-white/90">{task.title}</div>
            <div className="text-[10px] text-white/40 font-mono">{task.id}</div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[9px] px-2 py-0.5 rounded border font-medium uppercase tracking-wider ${cfg.bg} ${cfg.border} ${cfg.color}`}>
            {task.agent_class}
          </span>
          <span className={`text-[9px] px-2 py-0.5 rounded border font-medium uppercase tracking-wider ${
            task.status === 'completed' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25' :
            task.status === 'running' ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/25' :
            task.status === 'failed' ? 'bg-red-500/10 text-red-400 border-red-500/25' :
            'bg-white/[0.03] text-white/40 border-white/[0.08]'
          }`}>
            {task.status}
          </span>
        </div>

        {task.description && (
          <div>
            <div className="text-[9px] font-mono uppercase tracking-wider text-white/30 mb-1">Description</div>
            <p className="text-xs text-white/60 leading-relaxed">{task.description}</p>
          </div>
        )}

        {task.depends_on.length > 0 && (
          <div>
            <div className="text-[9px] font-mono uppercase tracking-wider text-white/30 mb-1">Depends On</div>
            <div className="flex flex-wrap gap-1">
              {task.depends_on.map(d => (
                <span key={d} className="text-[9px] px-2 py-0.5 rounded bg-white/[0.03] text-white/40 font-mono">{d}</span>
              ))}
            </div>
          </div>
        )}

        {task.result && (
          <div>
            <div className="text-[9px] font-mono uppercase tracking-wider text-emerald-400/60 mb-1">Result</div>
            <div className="text-xs text-emerald-400/70 bg-emerald-500/[0.03] rounded-lg p-3 border border-emerald-500/10 font-mono leading-relaxed whitespace-pre-wrap">
              {task.result}
            </div>
          </div>
        )}

        {task.error && (
          <div>
            <div className="text-[9px] font-mono uppercase tracking-wider text-red-400/60 mb-1">Error</div>
            <div className="text-xs text-red-400/70 bg-red-500/[0.03] rounded-lg p-3 border border-red-500/10 font-mono leading-relaxed whitespace-pre-wrap">
              {task.error}
            </div>
          </div>
        )}

        {task.agent_id && (
          <div className="flex items-center gap-2 text-[10px] text-white/40">
            <Bot size={12} className="text-cyan-500/50" />
            Agent: {task.agent_id}
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ─── Pre-flight credit estimate ─────────────────────────────────────

function PreFlightEstimate({ balance, nodeCount }: { balance: number; nodeCount: number }) {
  const estimate = useMemo(
    () => estimateRunCredits({ modelId: ESTIMATE_MODEL, nodeCount }),
    [nodeCount],
  );
  const sufficient = hasSufficientBalance(balance, estimate.estCredits);
  return (
    <div
      className={`mt-2 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[11px] font-mono ${
        sufficient
          ? 'border-white/[0.06] bg-white/[0.02] text-white/40'
          : 'border-amber-500/40 bg-amber-500/[0.06] text-amber-300'
      }`}
    >
      <span>
        Estimated run cost: <span className="text-white/80">{estimate.estCredits.toFixed(2)} cr</span>
        <span className="text-white/25"> ({nodeCount} nodes × {ESTIMATE_MODEL})</span>
      </span>
      {!sufficient && (
        <span className="flex items-center gap-2">
          <span>balance {balance.toFixed(2)} cr — insufficient</span>
          <a
            href="/pricing"
            className="rounded bg-amber-500 px-2 py-0.5 text-black font-semibold hover:bg-amber-400"
          >
            View plans
          </a>
        </span>
      )}
    </div>
  );
}

// ─── Top-up toast ────────────────────────────────────────────────────

function TopupToast({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="fixed bottom-5 left-1/2 z-[60] -translate-x-1/2 rounded-lg border border-cyan-500/30 bg-[#06061a]/95 px-4 py-3 shadow-2xl backdrop-blur-md">
      <div className="flex items-center gap-3 text-xs text-cyan-200">
        <Sparkles size={13} className="text-cyan-400" />
        <span>{message}</span>
        <button onClick={onClose} className="text-white/30 hover:text-white/70">
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export default function ExecutionOrchestrator() {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [decomposeResult, setDecomposeResult] = useState<DecomposeResult | null>(null);
  const [tasks, setTasks] = useState<SubTask[]>([]);
  const [agents, setAgents] = useState<AgentBrief[]>([]);
  const [selectedNode, setSelectedNode] = useState<SubTask | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectPaused, setProjectPaused] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<'pause' | 'resume' | 'cancel' | null>(null);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'live' | 'polling'>('polling');
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);

  // ── Credit-aware state ──
  const [paywall, setPaywall] = useState<PaywallState | null>(null);
  const paywallRef = useRef<PaywallState | null>(null);
  paywallRef.current = paywall;
  const { balance, refresh: refreshBalance } = useBalance({ intervalMs: 30_000 });
  const topupDeadlineRef = useRef<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 8_000);
  }, []);

  // Width observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(entries => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Poll agents
  useEffect(() => {
    if (!autoRefresh) return;
    const poll = async () => {
      try {
        const res = await fetch('/api/agents');
        const data = await res.json();
        if (data?.agents) setAgents(data.agents);
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  // Keep the node detail panel in sync with fresh task state
  useEffect(() => {
    if (!selectedNode) return;
    const fresh = tasks.find((t) => t.id === selectedNode.id);
    if (fresh && fresh !== selectedNode) setSelectedNode(fresh);
  }, [tasks, selectedNode]);

  // Fetch the full task tree from the engine and render it
  const refreshTree = useCallback(async (pid: string) => {
    try {
      const tree = await __orchestratorApi.api.getTaskTree(pid);
      setTasks(treeToSubTasks(tree));
      setEngineError(null);
    } catch (e) {
      const err = e as DecompositionApiError;
      setTasks([]);
      setEngineError(
        err?.status
          ? `Engine error (${err.status}): ${err.message}`
          : `Engine unreachable: ${err?.message || 'connection failed'} — is the backend running?`,
      );
      throw e;
    }
  }, []);

  // On 402 from any engine call → structured paywall state (renders PaywallPrompt modal).
  const openPaywallFromError = useCallback((err: DecompositionApiError, origin: PaywallState['origin']) => {
    const credits = extractInsufficientCredits(err?.detail);
    setPaywall({
      origin,
      creditsRequired: credits?.credits_required,
      creditsAvailable: credits?.credits_available,
    });
  }, []);

  // Pause the project + show resume-on-topup modal (mid-run out-of-credits).
  const handleOutOfCredits = useCallback(
    async (pid: string, origin: PaywallState['origin'], partial?: Partial<PaywallState>) => {
      setPaywall({ origin, ...partial });
      setProjectPaused(true);
      try {
        await __orchestratorApi.api.pauseProject(pid);
        await refreshTree(pid).catch(() => {});
      } catch {
        /* best-effort pause — the modal is the UX-critical piece */
      }
    },
    [refreshTree],
  );

  // After Stripe checkout returns (?session_id on the pricing return URL back here):
  // poll balance until it covers the required credits (max 60s), then resume.
  const waitForTopupAndResume = useCallback(
    async (pid: string, required?: number) => {
      topupDeadlineRef.current = Date.now() + TOPUP_POLL_TIMEOUT_MS;
      const tick = async (): Promise<boolean> => {
        const fresh = await refreshBalance();
        requestBalanceRefresh();
        if (fresh && (required == null || fresh.credits >= required)) {
          setPaywall(null);
          try {
            await __orchestratorApi.api.resumeProject(pid);
            setProjectPaused(false);
            await refreshTree(pid).catch(() => {});
            showToast('Balance topped up — execution resumed.');
          } catch (e) {
            showToast(`Top-up received but resume failed: ${(e as Error).message}`);
          }
          return true;
        }
        if (Date.now() > (topupDeadlineRef.current ?? 0)) {
          showToast('Still waiting on balance — resume manually once credits land.');
          return false;
        }
        await new Promise((r) => setTimeout(r, TOPUP_POLL_INTERVAL_MS));
        return tick();
      };
      await tick();
    },
    [refreshBalance, refreshTree, showToast],
  );

  // Detect return from Stripe checkout (?session_id on this page's URL).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    if (!sessionId) return;
    // Clean the URL so a refresh doesn't re-trigger the flow.
    params.delete('session_id');
    params.delete('success');
    const qs = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
    const pid = projectId;
    if (pid && (paywallRef.current || projectPaused)) {
      void waitForTopupAndResume(pid, paywallRef.current?.creditsRequired);
    } else {
      // No paused run in this view — just refresh the global indicator.
      void refreshBalance();
      requestBalanceRefresh();
      showToast('Checkout complete — balance refreshed.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Real engine execution loop:
  // create project (engine decomposes the goal) → start /execute → stream status.
  const startExecution = useCallback(async (pid: string) => {
    try {
      await __orchestratorApi.api.executeProject(pid);
      requestBalanceRefresh();
    } catch (e) {
      const err = e as DecompositionApiError;
      if (err?.status && isPaymentRequiredError(err.status)) {
        await handleOutOfCredits(pid, 'engine', {
          creditsRequired: extractInsufficientCredits(err?.detail)?.credits_required,
          creditsAvailable: extractInsufficientCredits(err?.detail)?.credits_available,
        });
      } else {
        setEngineError(`Execute failed: ${err?.message || 'unknown error'}`);
      }
    }
  }, [handleOutOfCredits]);

  const handleDecompose = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setSelectedNode(null);
    setEngineError(null);
    setTasks([]);
    setDecomposeResult(null);
    setProjectPaused(false);
    setPaywall(null);

    try {
      // ── Pre-flight: estimate credits for this run and gate on balance. ──
      const estimate = estimateRunCredits({ modelId: ESTIMATE_MODEL, nodeCount: 8 });
      const fresh = await refreshBalance();
      if (fresh && !hasSufficientBalance(fresh.credits, estimate.estCredits)) {
        setPaywall({
          origin: 'preflight',
          creditsRequired: estimate.estCredits,
          creditsAvailable: fresh.credits,
          estimatedRunCredits: estimate.estCredits,
        });
        return;
      }

      const project = await __orchestratorApi.api.createProject({
        description: text,
        deliverable_type: DeliverableType.OTHER,
        time_budget_hours: 1,
        metadata: { title: text.slice(0, 80), source: 'orchestrator-ui' },
      });
      setProjectId(project.project_id);

      // Server decomposes on create; render whatever exists so far, then execute.
      await refreshTree(project.project_id);
      setDecomposeResult({
        originalTask: text,
        subtasks: [],
        count: project.total_nodes,
        model: 'engine',
      });

      await startExecution(project.project_id);
    } catch (e) {
      const err = e as DecompositionApiError;
      if (err?.status && isPaymentRequiredError(err.status)) {
        openPaywallFromError(err, 'engine');
      } else {
        setEngineError(
          err?.status
            ? `Engine error (${err.status}): ${err.message}`
            : `Engine unreachable: ${err?.message || 'connection failed'}`,
        );
      }
      setTasks([]);
    } finally {
      setSending(false);
    }
  }, [input, sending, refreshTree, refreshBalance, openPaywallFromError, startExecution]);

  // Live updates: WS /api/decomposition/ws/{project_id}; on drop → poll /tree every 5s.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
    const startPolling = () => {
      if (pollTimer || cancelled) return;
      setWsStatus('polling');
      pollTimer = setInterval(() => {
        refreshTree(projectId).catch(() => {});
      }, 5000);
    };

    const connect = () => {
      if (cancelled) return;
      setWsStatus('connecting');
      try {
        ws = new WebSocket(decompositionApi.getWebSocketUrl(projectId));
      } catch {
        startPolling();
        return;
      }
      ws.onopen = () => {
        if (cancelled) return;
        attempts = 0;
        stopPolling();
        setWsStatus('live');
        try {
          ws?.send(JSON.stringify({ type: 'subscribe', project_id: projectId }));
        } catch {}
      };
      ws.onmessage = (ev) => {
        if (cancelled) return;
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg?.node && msg.node.id) {
            const node = msg.node as TaskNode;
            setTasks((prev) => {
              const idx = prev.findIndex((t) => t.id === node.id);
              if (idx < 0) {
                refreshTree(projectId).catch(() => {});
                return prev;
              }
              const next = [...prev];
              next[idx] = {
                ...next[idx],
                status: engineToUiStatus(node.status),
                error: node.last_error || next[idx].error,
                result: extractResultText(node) ?? next[idx].result,
                agent_id: node.assigned_worker_id ?? next[idx].agent_id,
              };
              return next;
            });
          } else {
            // tree-level events (new nodes, budgets, etc.) → full refetch
            refreshTree(projectId).catch(() => {});
          }
        } catch {
          refreshTree(projectId).catch(() => {});
        }
      };
      ws.onerror = () => {
        ws?.close();
      };
      ws.onclose = () => {
        if (cancelled) return;
        startPolling();
        attempts += 1;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5));
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();
    refreshTree(projectId).catch(() => {});

    return () => {
      cancelled = true;
      stopPolling();
      if (retryTimer) clearTimeout(retryTimer);
      try { ws?.close(); } catch {}
    };
  }, [projectId, refreshTree]);

  // Budget / milestone gates → real engine endpoints
  const handlePause = useCallback(async () => {
    if (!projectId || actionBusy) return;
    setActionBusy('pause');
    try {
      await __orchestratorApi.api.pauseProject(projectId);
      setProjectPaused(true);
      await refreshTree(projectId).catch(() => {});
    } catch (e) {
      setEngineError(`Pause failed: ${(e as Error).message}`);
    } finally {
      setActionBusy(null);
    }
  }, [projectId, actionBusy, refreshTree]);

  // Watch for a mid-run out-of-credits failure on any leaf → pause + paywall modal.
  useEffect(() => {
    if (!projectId || projectPaused || paywallRef.current) return;
    const creditFailed = tasks.find(
      (t) => t.status === 'failed' && isInsufficientCreditsFailure(t.error),
    );
    if (creditFailed) {
      void handleOutOfCredits(projectId, 'leaf', {
        creditsAvailable: balance?.credits,
      });
    }
  }, [tasks, projectId, projectPaused, handleOutOfCredits, balance]);

  const handleResume = useCallback(async () => {
    if (!projectId || actionBusy) return;
    setActionBusy('resume');
    try {
      await __orchestratorApi.api.resumeProject(projectId);
      setProjectPaused(false);
      setPaywall(null);
      await refreshTree(projectId).catch(() => {});
    } catch (e) {
      const err = e as DecompositionApiError;
      if (err?.status && isPaymentRequiredError(err.status)) {
        openPaywallFromError(err, 'engine');
      } else {
        setEngineError(`Resume failed: ${err?.message || 'unknown error'}`);
      }
    } finally {
      setActionBusy(null);
    }
  }, [projectId, actionBusy, refreshTree, openPaywallFromError]);

  const handleCancel = useCallback(async () => {
    if (!projectId || actionBusy) return;
    setActionBusy('cancel');
    try {
      await __orchestratorApi.api.cancelProject(projectId);
      await refreshTree(projectId).catch(() => {});
    } catch (e) {
      setEngineError(`Cancel failed: ${(e as Error).message}`);
    } finally {
      setActionBusy(null);
    }
  }, [projectId, actionBusy, refreshTree]);

  // Download the assembled deliverable via the engine's existing route
  const handleDownloadDeliverable = useCallback(async () => {
    if (!projectId) return;
    try {
      const blob = await __orchestratorApi.api.downloadDeliverable(projectId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `swarmagents-deliverable-${projectId.slice(0, 8)}`; // engine sets ext via blob type
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      setEngineError(`Download failed: ${(e as Error).message}`);
    }
  }, [projectId]);

  // Layout
  const filteredTasks = useMemo(() => {
    if (!statusFilter) return tasks;
    return tasks.filter(t => t.status === statusFilter);
  }, [tasks, statusFilter]);

  const layout = useMemo(() => buildLayout(filteredTasks, width - 40), [filteredTasks, width]);

  const activeCount = tasks.filter(t => t.status === 'running').length;
  const doneCount = tasks.filter(t => t.status === 'completed').length;
  const failedCount = tasks.filter(t => t.status === 'failed').length;
  const deliverableReady = tasks.length > 0 && tasks.every((t) => t.status === 'completed');

  // ─── Render ─────────────────────────────────────────────────

  return (
    <div className="flex flex-col min-h-0">
      {/* ── Input Bar ── */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-cyan-500/30 to-transparent" />
          <span className="text-[9px] font-mono uppercase tracking-[0.2em] text-cyan-500/60">Orchestrator</span>
          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-cyan-500/30 to-transparent" />
        </div>
        <div className="relative group">
          <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-cyan-500/10 to-blue-500/10 opacity-0 group-focus-within:opacity-100 transition-opacity blur-xl" />
          <div className="relative flex items-center gap-0 rounded-xl border border-white/[0.08] bg-black/60 backdrop-blur-xl overflow-hidden shadow-2xl transition-all focus-within:border-cyan-400/30 focus-within:shadow-cyan-500/5">
            <div className="flex items-center pl-4 text-cyan-500/50">
              <Brain size={16} />
            </div>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleDecompose(); }}
              placeholder="Describe what you want the swarm to build, research, or automate..."
              className="flex-1 bg-transparent px-3 py-3.5 text-sm text-white/80 placeholder-white/20 outline-none font-mono"
            />
            <button
              onClick={handleDecompose}
              disabled={sending || !input.trim()}
              className="flex items-center gap-2 px-6 py-3.5 bg-gradient-to-r from-cyan-500 to-blue-600 text-black text-xs font-bold tracking-wider uppercase hover:shadow-lg hover:shadow-cyan-500/25 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              {sending ? 'Decomposing...' : 'Deploy'}
            </button>
          </div>
        </div>
        {/* ── Pre-flight credit estimate ── */}
        {input.trim() && balance && (
          <PreFlightEstimate
            balance={balance.credits}
            nodeCount={8}
          />
        )}
      </div>

      {engineError && !paywall && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/[0.06] px-4 py-3">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-red-400" />
          <div className="text-xs text-red-300/90 font-mono leading-relaxed">{engineError}</div>
        </div>
      )}

      {/* ── Status bar ── */}
      {tasks.length > 0 && (
        <div className="flex items-center gap-4 px-4 py-2 mb-3 rounded-lg bg-[#06061a] border border-white/[0.04]">
          <div className="flex items-center gap-1.5 text-[10px] text-white/40">
            <GitBranch size={11} className="text-cyan-500/50" />
            {tasks.length} tasks
          </div>
          <div className="w-px h-3 bg-white/[0.06]" />
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse" />
            <span className="text-cyan-400/70">{activeCount} active</span>
          </div>
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span className="text-emerald-400/70">{doneCount} done</span>
          </div>
          {failedCount > 0 && (
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
              <span className="text-red-400/70">{failedCount} failed</span>
            </div>
          )}
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            {['all', 'running', 'completed', 'pending', 'failed'].map(f => (
              <button
                key={f}
                onClick={() => setStatusFilter(f === 'all' ? null : f)}
                className={`text-[9px] px-2 py-0.5 rounded transition-all uppercase tracking-wider font-medium ${
                  (f === 'all' && !statusFilter) || statusFilter === f
                    ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/25'
                    : 'text-white/30 hover:text-white/60 border border-transparent'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
          <button
            onClick={() => setAutoRefresh(v => !v)}
            className={`p-1 rounded transition-colors ${autoRefresh ? 'text-cyan-400/70' : 'text-white/20'}`}
            title="Auto-refresh"
          >
            <RefreshCw size={12} className={autoRefresh ? 'animate-spin' : ''} />
          </button>
        </div>
      )}

      {/* ── Stepper Laser Indicator (Prompt 3) ── */}
      {tasks.length > 0 && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-[#06061a]/85 border border-white/[0.04] space-y-3 shadow-lg">
          <div className="flex items-center justify-between text-[9px] font-mono tracking-wider">
            <span className="text-white/40">SWARM STEP PROGRESSION LAYER</span>
            <span className="text-cyan-400">{Math.round((doneCount / tasks.length) * 100)}% DISPATCHED</span>
          </div>
          
          {/* Active Step Line with laser animation */}
          <div className="relative h-1.5 w-full bg-black/40 rounded-full overflow-hidden border border-white/5">
            {/* Base Progress Line */}
            <motion.div
              layout
              className="absolute top-0 left-0 h-full bg-gradient-to-r from-purple-600 via-pink-500 to-cyan-400 rounded-full"
              style={{ width: `${(doneCount / tasks.length) * 100}%` }}
              transition={{ type: 'spring', stiffness: 100, damping: 20 }}
            />
            {/* Active step laser sweep */}
            {activeCount > 0 && (
              <div 
                className="absolute top-0 left-0 h-full w-full pointer-events-none rounded-full"
                style={{
                  background: 'linear-gradient(90deg, transparent, #06b6d4 50%, transparent)',
                  backgroundSize: '200% 100%',
                  animation: 'laser-sweep 1.5s linear infinite'
                }}
              />
            )}
          </div>
          
          {/* Micro stepping circles */}
          <div className="flex justify-between items-center relative px-2 pt-1">
            {tasks.map((t, idx) => {
              const isCompleted = t.status === 'completed';
              const isRunning = t.status === 'running';
              return (
                <div key={t.id} className="flex flex-col items-center gap-1.5">
                  <motion.div
                    className={`relative w-4 h-4 rounded-full border flex items-center justify-center text-[7px] font-bold font-mono transition-colors ${
                      isCompleted ? 'bg-emerald-500/20 border-emerald-400 text-emerald-400' :
                      isRunning ? 'bg-cyan-500/20 border-cyan-400 text-cyan-400 shadow-[0_0_8px_rgba(6,182,212,0.8)]' :
                      'bg-black border-white/10 text-white/30'
                    }`}
                    animate={{ scale: isRunning ? 1.2 : 1 }}
                  >
                    {isCompleted ? (
                      <motion.div
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 15 }}
                      >
                        <CheckCircle size={8} />
                      </motion.div>
                    ) : (
                      idx + 1
                    )}
                  </motion.div>
                  <span className="text-[7px] font-mono text-white/30 truncate max-w-[55px]" title={t.title}>
                    {t.title}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Tree Canvas ── */}
      <div
        ref={containerRef}
        className="relative rounded-xl border border-white/[0.04] bg-[#06061a]/50 p-5 overflow-auto flex-1 min-h-[500px]"
        onClick={() => setSelectedNode(null)}
      >
        {tasks.length === 0 ? (
          <div className="flex items-center justify-center h-full min-h-[400px]">
            <div className="text-center max-w-md">
              <Brain size={40} className="mx-auto mb-4 text-cyan-500/20" />
              <h3 className="text-sm font-semibold text-white/50 mb-2">Swarm Orchestrator</h3>
              <p className="text-xs text-white/30 leading-relaxed">
                Describe a task above. The orchestrator decomposes it into a parallel execution tree,
                spawns agents, and tracks progress until delivery.
              </p>
              {decomposeResult?.fallback && (
                <div className="mt-4 text-[10px] text-amber-400/60 bg-amber-500/[0.04] rounded-lg p-3 border border-amber-500/10">
                  LLM offline — using fallback decomposition
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="relative min-h-[400px]" onClick={e => e.stopPropagation()}>
            <SvgConnections layout={layout} containerRef={containerRef} />
            <div className="relative z-10" style={{ height: (layout.length > 0 ? Math.max(...layout.map(n => n.y + n.height)) : 400) + 40 }}>
              <AnimatePresence>
                {layout.map(node => {
                  const cfg = AGENT_CLASS_CONFIG[node.task.agent_class] || AGENT_CLASS_CONFIG.grunt;
                  const s = STATUS_NODE[node.task.status];
                  const isSelected = selectedNode?.id === node.task.id;
                  const StatusIcon = cfg.icon;

                  return (
                    <motion.div
                      key={node.task.id}
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                      transition={{ duration: 0.2 }}
                      className={`absolute rounded-lg border backdrop-blur-sm p-3 cursor-pointer transition-all duration-300 ${s.border} ${s.bg} ${s.pulse} ${isSelected ? 'ring-1 ring-cyan-500/40 shadow-lg shadow-cyan-500/10' : 'hover:-translate-y-0.5 hover:shadow-lg'}`}
                      style={{
                        left: node.x,
                        top: node.y,
                        width: node.width,
                      }}
                      onClick={e => { e.stopPropagation(); setSelectedNode(node.task); }}
                    >
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <StatusIcon size={12} className={`flex-shrink-0 ${cfg.color}`} />
                          <span className="text-[10px] font-semibold text-white/80 leading-tight line-clamp-2">{node.task.title}</span>
                        </div>
                        {node.task.status === 'running' && (
                          <div className="w-2 h-2 rounded-full border border-cyan-400 border-t-transparent animate-spin flex-shrink-0 mt-0.5" />
                        )}
                        {node.task.status === 'completed' && (
                          <CheckCircle size={10} className="text-emerald-400 flex-shrink-0 mt-0.5" />
                        )}
                      </div>

                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-[8px] px-1.5 py-px rounded border font-medium uppercase tracking-wider ${cfg.bg} ${cfg.border} ${cfg.color}`}>
                          {node.task.agent_class}
                        </span>
                        <span className={`text-[8px] font-mono ${
                          node.task.status === 'completed' ? 'text-emerald-400/60' :
                          node.task.status === 'running' ? 'text-cyan-400/60' :
                          node.task.status === 'failed' ? 'text-red-400/60' :
                          'text-white/20'
                        }`}>
                          {node.task.status === 'completed' ? 'DONE' :
                           node.task.status === 'running' ? 'RUN' :
                           node.task.status === 'failed' ? 'FAIL' :
                           node.task.status.toUpperCase()}
                        </span>
                      </div>

                      {node.task.status === 'running' && (
                        <div className="mt-2 h-1 rounded-full bg-white/[0.04] overflow-hidden">
                          <div className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-blue-500 animate-pulse w-2/3" />
                        </div>
                      )}
                    </motion.div>
                  );
                })}
              </AnimatePresence>

              {/* Final output node */}
              {doneCount > 0 && doneCount === tasks.filter(t => t.status !== 'failed').length && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="absolute left-1/2 -translate-x-1/2 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.03] p-4 text-center shadow-[0_0_40px_rgba(0,255,159,0.08)]"
                  style={{
                    top: (layout.length > 0 ? Math.max(...layout.map(n => n.y + n.height)) : 0) + 20,
                    width: 280,
                  }}
                >
                  <Sparkles size={24} className="mx-auto mb-1.5 text-emerald-400 drop-shadow-[0_0_8px_rgba(0,255,159,0.5)]" />
                  <div className="text-[8px] font-mono uppercase tracking-[0.25em] text-emerald-500/60 mb-0.5">Complete</div>
                  <div className="text-sm font-bold text-white/90">DELIVERABLE READY</div>
                  <div className="text-[9px] text-emerald-400/50 mt-1">All {doneCount} tasks completed</div>
                </motion.div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Detail Panel ── */}
      <AnimatePresence>
        <NodeDetailPanel task={selectedNode} onClose={() => setSelectedNode(null)} />
      </AnimatePresence>

      {/* ── Credit paywall modal (engine 402 / pre-flight gate / mid-run leaf failure) ── */}
      {paywall && (
        <PaywallPrompt
          variant="modal"
          creditsRequired={paywall.creditsRequired ?? paywall.estimatedRunCredits}
          creditsAvailable={paywall.creditsAvailable ?? balance?.credits}
          onDismiss={() => setPaywall(null)}
        />
      )}

      {/* ── Toast (top-up confirmed / resume status) ── */}
      {toast && <TopupToast message={toast} onClose={() => setToast(null)} />}
    </div>
  );
}