'use client';

import { useState, useEffect, useCallback, useRef, useImperativeHandle, Suspense } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  AlertTriangle, RotateCcw,
  Maximize2, Minimize2, PanelRightClose, PanelRightOpen
} from 'lucide-react';
import type { SwarmTreeNode } from '@/components/swarm/SwarmDecompositionTree';
import { buildWsUrl } from '@/lib/config';
import TimeBudgetControl, {
  timeBudgetFromHours,
  timeBudgetFromLabel,
} from '@/components/TimeBudgetControl';
import FitMeter from '@/components/FitMeter';
import DecompSummaryPanel from '@/components/DecompSummaryPanel';
import DecompNodeDetail from '@/components/DecompNodeDetail';
import DecompProgressBanner, {
  type DecompProgress,
} from '@/components/DecompProgressBanner';
import {
  computeFitMeter,
  computeTreeSummary,
  computeBudgetTargets,
  expectedLeavesHint,
  type FitMeter as FitMeterData,
} from '@/lib/timeBudget';
import PaywallPrompt from '@/components/billing/PaywallPrompt';
import { useBalance, requestBalanceRefresh } from '@/hooks/useBalance';
import { estimateRunCredits, hasSufficientBalance } from '@/lib/executionEstimate';
import { MODEL_PRICES } from '@/lib/modelPricing';
import { extractInsufficientCredits, isPaymentRequiredError } from '@/lib/billingClient';
import type { DecompNode, DecompTreeSummary } from '@/stores/swarmStore';
import type { SteerChatMessage } from '@/components/SteeringPanel';
import RequireAuth from '@/components/auth/RequireAuth';
import { authHeaders, getStoredUser } from '@/lib/auth';
import ConsoleShell from '@/components/ConsoleShell';
import UnifiedCommandBar, {
  type AttachedFile as BarAttachedFile,
} from '@/components/command/UnifiedCommandBar';
import type { TimeBudgetValue } from '@/components/TimeBudgetControl';
import DeliverableReadyBanner from '@/components/DeliverableReadyBanner';
import {
  rememberActiveDecompSession,
  readActiveDecompSessionId,
} from '@/lib/decompPersistence';
import { useMissionTerminalFeed } from '@/hooks/useMissionTerminalFeed';

type AttachedFile = { name: string; size: number; type: string; content?: string };

const ExecutionDagCanvas = dynamic(
  () => import('@/components/decomp/ExecutionDagCanvas'),
  { ssr: false }
);
const SteeringPanel = dynamic(() => import('@/components/SteeringPanel'), { ssr: false });
const AgentSandboxGrid = dynamic(() => import('@/components/AgentSandboxGrid'), { ssr: false });
const WorkspaceIDE = dynamic(() => import('@/components/WorkspaceIDE'), { ssr: false });
const ConsoleTerminal = dynamic(() => import('@/components/ConsoleTerminal'), { ssr: false });
const TrajectoryTimeline = dynamic(
  () => import('@/components/timeline/TrajectoryTimeline'),
  { ssr: false },
);

const EXAMPLE_MISSIONS = [
  {
    id: 'tool_qa',
    label: '10m web',
    budget: '10 minutes',
    text: 'Build a complete local web app for agent tool QA (~10 minute budget). Deliverable: index.html titled "SwarmAgents Tool QA", styles.css (header, main, status-panel), app.js checklist for file_write/shell_exec/npm_test/deliverable, package.json with test→scripts/smoke.js, README. npm test must pass.',
  },
  {
    id: 'api',
    label: '1h API',
    budget: '1 hour',
    text: 'Build a typed REST API for a todo app with auth, CRUD, tests, and a Docker Compose stack.',
  },
  {
    id: 'fix',
    label: '30m fix',
    budget: '30 minutes',
    text: 'Find and fix flaky tests in the dashboard, add a regression test, and document the root cause.',
  },
  {
    id: 'research',
    label: '3h research',
    budget: '3 hours',
    text: 'Research local LLM agent tool-use patterns, write a short brief with citations, and propose an architecture for SwarmAgents.',
  },
];

const ESTIMATE_MODEL = MODEL_PRICES['DeepSeek-V4-Flash']
  ? 'DeepSeek-V4-Flash'
  : Object.keys(MODEL_PRICES)[0];

interface Task {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  assigned_worker?: string;
  type: string;
}

function flattenSessionToTree(nodes: any[]): SwarmTreeNode[] {
  const flat: SwarmTreeNode[] = [];
  const walk = (list: any[], parentId: string | null = null, depth = 0) => {
    for (const n of list || []) {
      flat.push({
        id: n.id,
        parent_id: parentId,
        description: n.label || n.description || n.id,
        label: n.label,
        status: n.status || 'pending',
        type: n.type || 'task',
        depth,
        time_budget: (n.effort_minutes || 0) * 60,
        estimated_duration: (n.effort_minutes || 0) * 60,
        effort_minutes: n.effort_minutes,
        tags: [n.agent_class || n.type || 'task'],
        agent_class: n.agent_class,
        model_tier: n.model_tier,
        tools: n.tools,
        acceptance_criteria: n.acceptance_criteria,
        depends_on: n.depends_on,
        deliverable_path: n.deliverable_path,
        assigned_worker_id: n.assignedAgent || n.assigned_worker_id || undefined,
        assigned_provider: n.assignedProvider || n.assigned_provider || undefined,
        last_pulse: n.last_pulse || undefined,
        priority: n.priority === 'critical' ? 10 : n.priority === 'high' ? 8 : 5,
      });
      if (n.children?.length) walk(n.children, n.id, depth + 1);
    }
  };
  walk(nodes);
  return flat;
}

function DecompPageInner() {
  const searchParams = useSearchParams();
  const presetApplied = useRef(false);
  const autostartRef = useRef(false);
  const [projectId, setProjectId] = useState<string>('');
  const [decompSessionId, setDecompSessionId] = useState<string>('');
  const [taskInput, setTaskInput] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [attachedImages, setAttachedImages] = useState<AttachedFile[]>([]);
  const [steerSending, setSteerSending] = useState(false);
  const [timeBudget, setTimeBudget] = useState<TimeBudgetValue>(() => timeBudgetFromHours(1));
  const [decompFit, setDecompFit] = useState<FitMeterData | null>(null);
  const [decompSummary, setDecompSummary] = useState<DecompTreeSummary | null>(null);
  const [selectedDecompNode, setSelectedDecompNode] = useState<DecompNode | null>(null);
  // Inspector drawer: Esc closes the current selection.
  useEffect(() => {
    if (!selectedDecompNode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedDecompNode(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedDecompNode]);

  useEffect(() => {
    if (presetApplied.current) return;
    const preset = searchParams.get('preset');
    const goal = searchParams.get('goal');
    const budgetParam = searchParams.get('budget');
    const mission = preset
      ? EXAMPLE_MISSIONS.find((m) => (m as { id?: string }).id === preset)
      : undefined;
    if (!mission && !goal) return;
    presetApplied.current = true;
    if (mission) {
      setTaskInput(mission.text);
      setTimeBudget(timeBudgetFromLabel(mission.budget));
    } else if (goal) {
      setTaskInput(goal);
      if (budgetParam) setTimeBudget(timeBudgetFromLabel(budgetParam));
    }
  }, [searchParams]);
  const [swarmPaused, setSwarmPaused] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [decompProgress, setDecompProgress] = useState<DecompProgress | null>(null);
  const [runtimeInfo, setRuntimeInfo] = useState<{
    currentMilestoneId?: string;
    milestones?: Array<{ id: string; label: string; status: string }>;
    checkpoints?: Array<{ id: string; label: string; status: string }>;
    ambition?: string;
    trajectorySteps?: number;
    trajectoryTarget?: number;
  } | null>(null);
  const [orgSeats, setOrgSeats] = useState<
    Array<{ id: string; title: string; status: string; ownsPaths?: string[]; leafIds?: string[] }>
  >([]);
  const [blackboardCount, setBlackboardCount] = useState(0);
  const [heatmapTop, setHeatmapTop] = useState<string[]>([]);
  const [organizerNote, setOrganizerNote] = useState<string | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string>('');
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  const [ideOpenPath, setIdeOpenPath] = useState<string | null>(null);
  const deepenAbort = useRef(false);
  const missionLogRef = useRef<(kind: 'input' | 'output' | 'error' | 'system', text: string) => void>(() => {});
  const {
    lines: missionTerminalLines,
    append: appendMissionLog,
    connected: missionTerminalLive,
  } = useMissionTerminalFeed(decompSessionId || null, projectId || null);

  useEffect(() => {
    missionLogRef.current = appendMissionLog;
  }, [appendMissionLog]);
  
  // Real-time project tracking
  const [projectStatus, setProjectStatus] = useState<'idle' | 'running' | 'paused' | 'completed' | 'failed'>('idle');
  const [subtasks, setSubtasks] = useState<Task[]>([]);
  const [treeNodes, setTreeNodes] = useState<SwarmTreeNode[]>([]);
  const [timeRemaining, setTimeRemaining] = useState<number>(3600);
  const [timeConsumed, setTimeConsumed] = useState<number>(0);
  const [executionMode, setExecutionMode] = useState<'sandboxed' | 'yolo'>('yolo');

  const [chatMessages, setChatMessages] = useState<SteerChatMessage[]>([
    {
      sender: 'agent',
      from: 'Orchestrator',
      text: "Send an objective above, then talk to the collective or me here — agents will reply as they work.",
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      status: 'applied',
    },
  ]);

  const [paywall, setPaywall] = useState<{
    creditsRequired?: number;
    creditsAvailable?: number;
  } | null>(null);
  const { balance, refresh: refreshBalance } = useBalance({ intervalMs: 30_000 });

  // Layout toggles
  const [isLeftCollapsed, setIsLeftCollapsed] = useState(false);
  const [isSteeringOpen, setIsSteeringOpen] = useState(true);
  const [isCanvasMaximized, setIsCanvasMaximized] = useState(false);

  const refreshProject = useCallback(async () => {
    if (!projectId) return;
    const res = await fetch(`/api/tasks/${projectId}`);
    if (!res.ok) return;
    const data = await res.json();
    setProjectStatus(data.status || 'running');
    if (data.subtasks) setSubtasks(data.subtasks);
    if (data.tree_nodes) setTreeNodes(data.tree_nodes);
    if (data.time_budget_sec || data.time_budget) {
      const budget = data.time_budget_sec || (data.time_budget * 3600);
      setTimeConsumed(data.time_consumed_sec || data.time_consumed || 0);
      setTimeRemaining(Math.max(0, budget - (data.time_consumed_sec || data.time_consumed || 0)));
    }
    if (data.status === 'completed' || data.status === 'failed') setIsExecuting(false);
  }, [projectId]);

  // Poll + WebSocket for live tree updates
  useEffect(() => {
    if (!projectId || projectStatus !== 'running') return;

    refreshProject();
    const interval = setInterval(refreshProject, 4000);

    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(buildWsUrl(`/api/decomposition/ws/${projectId}`));
      ws.onmessage = () => refreshProject();
      ws.onopen = () => ws?.send(JSON.stringify({ type: 'ping' }));
    } catch { /* ws optional */ }

    return () => {
      clearInterval(interval);
      ws?.close();
    };
  }, [projectId, projectStatus, refreshProject]);

  // Listen for agent archetype changes in node detail panel
  useEffect(() => {
    const handleArchetypeChange = (e: any) => {
      const { nodeId, archetype } = e.detail;
      setTreeNodes((prev) =>
        prev.map((node) => {
          if (node.id === nodeId) {
            return { ...node, agent_class: archetype, tags: [archetype] };
          }
          return node;
        })
      );
    };
    window.addEventListener('agent-archetype-changed', handleArchetypeChange);
    return () => window.removeEventListener('agent-archetype-changed', handleArchetypeChange);
  }, []);

  // Format seconds to HH:MM:SS
  const formatTime = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return [h, m, s].map(v => v.toString().padStart(2, '0')).join(':');
  };

  const applySessionSnapshot = useCallback((session: any, fit?: FitMeterData, summary?: DecompTreeSummary) => {
    const f = fit || session.fit || computeFitMeter(session.nodes, timeBudget.minutes);
    const s = summary || session.summary || computeTreeSummary(session.nodes);
    setDecompFit(f);
    setDecompSummary(s);
    setTreeNodes(flattenSessionToTree(session.nodes));
    setDecompSessionId(session.id);
    setProjectId((prev) => prev || session.id);
    rememberActiveDecompSession(session.id, getStoredUser()?.id);
    setSwarmPaused(Boolean(session.paused));
    if (typeof session.project === 'string' && session.project.trim()) {
      setTaskInput((prev) => (prev.trim() ? prev : session.project));
    }
    if (session.status === 'paused') {
      setProjectStatus('paused');
      setIsExecuting(false);
    } else if (session.status === 'completed' || session.status === 'done') {
      setProjectStatus('completed');
      setIsExecuting(false);
    } else if (session.status === 'running' || session.status === 'executing') {
      setProjectStatus('running');
    } else if (Array.isArray(session.nodes) && session.nodes.length) {
      setProjectStatus((prev) => (prev === 'idle' ? 'paused' : prev));
    }
    if (session.progress) setDecompProgress(session.progress);
    if (session.runtime) setRuntimeInfo(session.runtime);
    if (typeof session.workspace_path === 'string' && session.workspace_path) {
      setWorkspacePath(session.workspace_path);
    }
    if (Array.isArray(session.seats)) {
      setOrgSeats(
        session.seats
          .filter((s: { status?: string }) => s.status !== 'retired')
          .map((s: any) => ({
            id: s.id,
            title: s.title,
            status: s.status,
            ownsPaths: s.ownsPaths,
            leafIds: s.leafIds,
          }))
      );
    }
    if (session.blackboard?.count != null) setBlackboardCount(Number(session.blackboard.count));
    return { fit: f, summary: s };
  }, [timeBudget.minutes]);

  const refreshWorkspace = useCallback(async (sessionId: string) => {
    if (!sessionId) return;
    try {
      const res = await fetch(
        `/api/tasks/workspace?sessionId=${encodeURIComponent(sessionId)}&heatmap=1`,
        {
          headers: authHeaders(),
        }
      );
      const data = await res.json();
      if (!data?.ok) return;
      setWorkspacePath(String(data.workspace || ''));
      const files: string[] = Array.isArray(data.files) ? data.files : [];
      setWorkspaceFiles(files);
      if (data.session) {
        applySessionSnapshot(data.session);
      }
      if (Array.isArray(data.seats)) {
        setOrgSeats(
          data.seats
            .filter((s: { status?: string }) => s.status !== 'retired')
            .map((s: any) => ({
              id: s.id,
              title: s.title,
              status: s.status,
              ownsPaths: s.ownsPaths,
              leafIds: s.leafIds,
            }))
        );
      }
      if (Array.isArray(data.heatmap)) {
        setHeatmapTop(data.heatmap.slice(0, 6).map((h: { path: string }) => h.path));
      }
      if (Array.isArray(data.blackboard)) setBlackboardCount(data.blackboard.length);
      const pick =
        files.find((f) => f.startsWith('src/') || f.startsWith('deliverables/')) ||
        files.find((f) => !f.endsWith('README.md')) ||
        files[0];
      if (pick) setIdeOpenPath(pick);
    } catch {
      /* ignore */
    }
  }, []);

  const runAutoExecute = useCallback(
    async (sessionId: string) => {
      setIsExecuting(true);
      setProjectStatus('running');
      missionLogRef.current('system', 'auto-execute: swarm runtime engaged');
      setChatMessages((prev) => [
        ...prev,
        {
          sender: 'agent',
          text: 'Full swarm runtime: tool-using agents + Hamiltonian pulses + watcher milestones. Leaves write into a real workspace.',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          status: 'applied',
        },
      ]);

      for (let i = 0; i < 20000; i++) {
        if (deepenAbort.current) break;
        // Prefer server-side multi-batch orchestrator every few client ticks
        const useOrch = i % 4 === 0;
        const res = await fetch('/api/tasks/decompose', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify(
            useOrch
              ? { action: 'orchestrate_until_done', sessionId, batchSize: 2, maxRounds: 8 }
              : { action: 'execute_leaves', sessionId, batchSize: 2 }
          ),
        });
        if (!res.ok) break;
        const data = await res.json();
        if (!data.ok || !data.session) break;
        applySessionSnapshot(data.session, data.fit, data.summary);
        if (i % 2 === 0) void refreshWorkspace(sessionId);
        if (Array.isArray(data.seats)) {
          setOrgSeats(
            data.seats
              .filter((s: { status?: string }) => s.status !== 'retired')
              .map((s: any) => ({
                id: s.id,
                title: s.title,
                status: s.status,
                ownsPaths: s.ownsPaths,
                leafIds: s.leafIds,
              }))
          );
        }
        if (typeof data.blackboardCount === 'number') setBlackboardCount(data.blackboardCount);
        if (Array.isArray(data.heatmapTop)) setHeatmapTop(data.heatmapTop);
        if (data.organizer?.events?.length) {
          const last = data.organizer.events[data.organizer.events.length - 1];
          if (last?.message) {
            setOrganizerNote(String(last.message));
            missionLogRef.current('system', `organizer: ${last.message}`);
          }
          if (data.organizer.applied > 0) {
            setChatMessages((prev) => [
              ...prev,
              {
                sender: 'agent',
                from: 'Organizer',
                text: `Tree update — spawned ${data.organizer.spawned || 0}, deepened ${data.organizer.deepened || 0}, skipped ${data.organizer.skipped || 0}, merged ${data.organizer.merged || 0}.`,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                status: 'applied',
              },
            ]);
          }
        }

        const rt = data.runtime || data.session.runtime;
        if (rt?.currentMilestoneId && i % 3 === 0) {
          const ms = (rt.milestones || []).find((m: { status: string }) => m.status === 'active');
          if (ms) {
            setChatMessages((prev) => [
              ...prev,
              {
                sender: 'agent',
                text: `Runtime: ${ms.label} · roles=${(rt.roleAllocation || [])
                  .slice(0, 3)
                  .map((r: { roleId: string }) => r.roleId)
                  .join(', ')}`,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                status: 'applied',
              },
            ]);
          }
        }

        if (data.paused || data.watcher?.pause) {
          setProjectStatus('paused');
          setSwarmPaused(true);
          setChatMessages((prev) => [
            ...prev,
            {
              sender: 'agent',
              text:
                data.watcher?.events?.slice(-1)?.[0]?.message ||
                'Watcher paused the run. Say “resume” in chat to continue.',
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              status: 'partial',
            },
          ]);
          break;
        }

        const watchNotes = (data.watcher?.events || [])
          .filter((e: { level: string }) => e.level === 'action' || e.level === 'warn')
          .slice(-2);
        for (const note of watchNotes) {
          missionLogRef.current('system', `watcher: ${note.message}`);
          setChatMessages((prev) => [
            ...prev,
            {
              sender: 'agent',
              text: `Watcher: ${note.message}`,
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              status: note.level === 'warn' ? 'partial' : 'applied',
            },
          ]);
        }

        const batch = data.executed || [];
        if (batch.length) {
          const okN = batch.filter((x: { ok: boolean }) => x.ok).length;
          const repairedN = Number(data.repaired) || batch.filter((x: { repaired?: boolean }) => x.repaired).length;
          const fail = batch.find((x: { ok: boolean; error?: string }) => !x.ok);
          const batchMsg = fail?.error?.includes('No LLM')
            ? `Stopped: ${fail.error}. Add providers under Settings → Agents.`
            : repairedN > 0
              ? `Gate repair queued for ${repairedN} leaf(s). Progress ${data.completed}/${data.total} passed · ${data.repairing || 0} repairing.`
              : `Agents finished ${data.completed}/${data.total} tasks (${okN} this round).`;
          missionLogRef.current(fail?.error?.includes('No LLM') ? 'error' : 'output', batchMsg);
          setChatMessages((prev) => [
            ...prev,
            {
              sender: 'agent',
              text: batchMsg,
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              status: fail?.error?.includes('No LLM') ? 'rejected' : 'applied',
            },
          ]);
          if (fail?.error?.includes('No LLM')) break;
        }

        if (data.done) {
          setProjectStatus('completed');
          setIsExecuting(false);
          await refreshWorkspace(sessionId);
          setChatMessages((prev) => [
            ...prev,
            {
              sender: 'agent',
              text: `Deliverable ready — all ${data.total} leaf tasks passed. Open the workspace below to review and download.`,
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              status: 'applied',
            },
          ]);
          return true;
        }
        if (data.terminal && !data.done) {
          setProjectStatus('failed');
          setIsExecuting(false);
          setChatMessages((prev) => [
            ...prev,
            {
              sender: 'agent',
              text: `Run stopped — ${data.failed || 0}/${data.total} leaf(s) exhausted gate repairs. Re-run failed branches to retry.`,
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              status: 'rejected',
            },
          ]);
          return false;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      setIsExecuting(false);
      return false;
    },
    [applySessionSnapshot, refreshWorkspace]
  );

  const handleAbortRun = useCallback(async () => {
    deepenAbort.current = true;
    setIsSubmitting(false);
    setIsExecuting(false);
    setProjectStatus('paused');
    setSwarmPaused(true);
    setDecompProgress(null);
    setChatMessages((prev) => [
      ...prev,
      {
        sender: 'agent',
        text: 'Aborted — decomposition and agents stopped. Adjust the brief or hit Send again.',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        status: 'partial',
      },
    ]);
    if (decompSessionId) {
      try {
        await fetch('/api/tasks/steer', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            sessionId: decompSessionId,
            projectId: projectId || decompSessionId,
            action: 'pause',
            message: 'abort',
          }),
        });
      } catch {
        /* local abort already applied */
      }
    }
  }, [decompSessionId, projectId]);

  const runProgressiveDeepen = useCallback(
    async (sessionId: string) => {
      deepenAbort.current = false;
      let guard = 0;
      while (!deepenAbort.current && guard < 80) {
        guard++;
        const res = await fetch('/api/tasks/decompose', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ action: 'deepen_step', sessionId }),
        });
        if (!res.ok) break;
        const data = await res.json();
        if (!data.ok || !data.session) break;
        applySessionSnapshot(data.session, data.fit, data.summary);
        if (data.progress) setDecompProgress(data.progress);
        if (data.done) {
          setDecompProgress(null);
          const fit = data.fit || data.session.fit;
          setChatMessages((prev) => [
            ...prev,
            {
              sender: 'agent',
              text: `Tree ready — ${fit?.leafCount ?? '?'} tasks for your ${timeBudget.label} budget. Starting agents from Settings…`,
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              status: 'applied',
            },
          ]);
          return true;
        }
      }
      return false;
    },
    [applySessionSnapshot, timeBudget.label]
  );

  const handleStartDecomposition = async (override?: {
    project?: string;
    budget?: TimeBudgetValue;
    files?: AttachedFile[];
    images?: AttachedFile[];
  }) => {
    const project = (override?.project ?? taskInput).trim();
    const budget = override?.budget ?? timeBudget;
    const files = override?.files ?? attachedFiles;
    const images = override?.images ?? attachedImages;
    if (!project) return;
    if (override?.project) setTaskInput(override.project);
    if (override?.budget) setTimeBudget(override.budget);
    deepenAbort.current = false;
    setIsSubmitting(true);
    setIsExecuting(false);
    setActionError(null);
    setPaywall(null);

    const targets = computeBudgetTargets(budget.minutes);
    const estimate = estimateRunCredits({
      modelId: ESTIMATE_MODEL,
      nodeCount: Math.max(4, targets.targetLeaves),
    });
    const fresh = await refreshBalance();
    if (fresh && !hasSufficientBalance(fresh.credits, estimate.estCredits)) {
      setPaywall({
        creditsRequired: estimate.estCredits,
        creditsAvailable: fresh.credits,
      });
      setIsSubmitting(false);
      return;
    }

    setDecompFit(null);
    setTreeNodes([]);
    setSelectedDecompNode(null);
    setTimeRemaining(budget.minutes * 60);
    setTimeConsumed(0);
    setProjectStatus('running');
    missionLogRef.current('system', `mission start · budget ${budget.label}`);
    setDecompProgress({
      phase: 'initial',
      leafCount: 0,
      targetLeaves: 0,
      message: `Starting decomp for ${budget.label} (${expectedLeavesHint(budget.minutes)})…`,
    });
    setChatMessages((prev) => [
      ...prev,
      {
        sender: 'user',
        text: `Run: ${project.slice(0, 120)}${project.length > 120 ? '…' : ''} · ${budget.label}`,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
    try {
      const fileContext = files
        .filter((f) => f.content)
        .map((f) => `--- ${f.name} ---\n${f.content}`)
        .join('\n\n')
        .slice(0, 8000);

      const decompRes = await fetch('/api/tasks/decompose', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          action: 'decompose',
          project,
          timeRequirement: budget.label,
          timeBudgetMinutes: budget.minutes,
          autoDeepen: true,
          progressive: true,
          execution_mode: executionMode,
          yolo_mode: executionMode === 'yolo',
          userId: getStoredUser()?.id,
          github_repo: githubUrl || undefined,
          attached_files: files.map((f) => ({ name: f.name, size: f.size, type: f.type, content: f.content })),
          attached_images: images.map((i) => ({ name: i.name, size: i.size, type: i.type })),
          file_context: fileContext || undefined,
        }),
      });
      const decompData = await decompRes.json().catch(() => null);
      const paywallCode = typeof decompData?.code === 'string' ? decompData.code : undefined;
      if (decompRes.status === 402 || isPaymentRequiredError(decompRes.status, paywallCode)) {
        const credits = extractInsufficientCredits(decompData);
        setPaywall({
          creditsRequired: credits?.credits_required,
          creditsAvailable: credits?.credits_available ?? fresh?.credits,
        });
        setProjectStatus('idle');
        setIsExecuting(false);
        return;
      }
      if (!decompRes.ok || !decompData?.ok || !decompData.session) {
        throw new Error(decompData?.error || `Decomposition failed (${decompRes.status})`);
      }

      const session = decompData.session;
      applySessionSnapshot(session, decompData.fit, decompData.summary);
      const domain = session.mission?.domain || session.decomp_meta?.domain;
      const degraded = Boolean(decompData.degraded || decompData.source === 'fallback');
      setChatMessages((prev) => [
        ...prev,
        {
          sender: 'agent',
          text: degraded
            ? `Fallback tree for ${budget.label}${domain ? ` · ${domain}` : ''} — deepening toward ~${decompData.targets?.targetLeaves ?? '?'} tasks.`
            : `Decomposing for ${budget.label}${domain ? ` · ${domain}` : ''} — targeting ~${decompData.targets?.targetLeaves ?? '?'} tasks. Graph grows live.`,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          status: degraded ? 'partial' : 'applied',
        },
      ]);

      void fetch('/api/tasks/create', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          title: project.slice(0, 50),
          description: project,
          time_budget_hours: budget.minutes / 60,
          auto_decompose: true,
          github_repo: githubUrl || undefined,
          attached_files: files.map((f) => f.name),
          attached_images: images.map((i) => i.name),
        }),
      })
        .then(async (res) => {
          if (!res.ok) return;
          const data = await res.json();
          const pid = data.task?.id || data.project?.project_id;
          if (pid) setProjectId(pid);
        })
        .catch(() => undefined);

      if (decompData.deepening || decompData.progressive) {
        await runProgressiveDeepen(session.id);
      }
      if (deepenAbort.current) {
        setProjectStatus('paused');
        setIsExecuting(false);
        return;
      }
      await runAutoExecute(session.id);
      requestBalanceRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isQuotaErr = msg.includes('quota') || msg.includes('reserved') || msg.includes('BYOK') || msg.includes('DeepSeek');
      const userFriendlyMsg = isQuotaErr
        ? 'Azure cloud quota is reserved for admin. To run decompositions, enter your own API key in Settings or connect to local Ollama (http://localhost:11434).'
        : `Decomp failed: ${msg}`;
      setActionError(userFriendlyMsg);
      setProjectStatus('idle');
      setIsExecuting(false);
      setDecompProgress({ phase: 'error', message: userFriendlyMsg });
      setChatMessages((prev) => [
        ...prev,
        {
          sender: 'agent',
          text: userFriendlyMsg,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          status: 'rejected',
        },
      ]);
    } finally {
      setIsSubmitting(false);
    }
  };

  /** Budget choices surfaced inline on the unified command bar (15m/1h/4h/1d). */
  const barBudgetOptions: TimeBudgetValue[] = [1 / 3, 1, 4, 24].map((h) =>
    timeBudgetFromHours(h)
  );

  /** Unified bar -> existing decomposition pipeline (single launch path). */
  const handleBarLaunch = useCallback(
    ({
      text,
      files: barFiles,
      images: barImages,
    }: {
      text: string;
      files: BarAttachedFile[];
      images: BarAttachedFile[];
    }) => {
      if (!text.trim()) return;
      const files: AttachedFile[] = barFiles.map((f) => ({
        name: f.name,
        size: f.size,
        type: f.type,
        content: f.content,
      }));
      const images: AttachedFile[] = barImages.map((i) => ({
        name: i.name,
        size: i.size,
        type: i.type,
      }));
      void handleStartDecomposition({ project: text, files, images });
    },
    [handleStartDecomposition, githubUrl, executionMode]
  );

  /** Unified bar (steer mode) -> /api/tasks/steer. */
  const handleSteerSend = useCallback(
    async (text: string) => {
      const msgText = text.trim();
      if (!msgText || steerSending) return;
      setChatMessages((prev) => [
        ...prev,
        {
          sender: 'user',
          from: 'You',
          text: msgText,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
      setSteerSending(true);
      try {
        const res = await fetch('/api/tasks/steer', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            sessionId: decompSessionId || undefined,
            projectId: projectId || decompSessionId || undefined,
            nodeId: selectedDecompNode?.id || undefined,
            message: msgText,
          }),
        });
        const data = await res.json().catch(() => null);
        if (data?.session) {
          applySessionSnapshot(data.session);
        }
        setChatMessages((prev) => [
          ...prev,
          {
            sender: 'agent',
            from: 'Orchestrator',
            text: data?.response || data?.error || (res.ok ? 'Directive acknowledged and applied.' : 'Steering request failed.'),
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            status: data?.status || (data?.ok ? 'applied' : 'rejected'),
          },
        ]);
      } catch (err) {
        setChatMessages((prev) => [
          ...prev,
          {
            sender: 'agent',
            from: 'Orchestrator',
            text: `Failed to transmit steering: ${String(err)}`,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            status: 'rejected',
          },
        ]);
      } finally {
        setSteerSending(false);
      }
    },
    [steerSending, decompSessionId, projectId, selectedDecompNode?.id, applySessionSnapshot]
  );

  /** Wipe the current decomposition tree and reset dashboard to blank slate */
  const handleStartFresh = useCallback(() => {
    deepenAbort.current = true;
    setIsSubmitting(false);
    setIsExecuting(false);
    setProjectStatus('idle');
    setSwarmPaused(false);
    setTreeNodes([]);
    setDecompFit(null);
    setDecompSummary(null);
    setDecompProgress(null);
    setSelectedDecompNode(null);
    setRuntimeInfo(null);
    setOrgSeats([]);
    setBlackboardCount(0);
    setHeatmapTop([]);
    setOrganizerNote(null);
    setActionError(null);
    setPaywall(null);
    setTaskInput('');
    setProjectId('');
    setDecompSessionId('');
    setWorkspacePath('');
    setWorkspaceFiles([]);
    setAttachedFiles([]);
    setAttachedImages([]);
    setSubtasks([]);
    setChatMessages([
      {
        sender: 'agent',
        from: 'Orchestrator',
        text: 'Started fresh — slate is clear. Send a new objective above.',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        status: 'applied',
      },
    ]);
    // Clear server-side session pointer from local storage
    try {
      const { rememberActiveDecompSession } = require('@/lib/decompPersistence');
      rememberActiveDecompSession(null);
    } catch { /* ignore */ }
  }, []);


  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      try {
        const draft = sessionStorage.getItem('swarm_draft_mission');
        if (draft) {
          setTaskInput(draft);
          sessionStorage.removeItem('swarm_draft_mission');
          const b = sessionStorage.getItem('swarm_draft_budget');
          if (b) setTimeBudget(timeBudgetFromLabel(b));
          const yolo = sessionStorage.getItem('swarm_draft_yolo');
          if (yolo === 'true') setExecutionMode('yolo');

          const rawAtts = sessionStorage.getItem('swarm_draft_attachments');
          if (rawAtts) {
            try {
              const parsed = JSON.parse(rawAtts);
              if (Array.isArray(parsed)) {
                const files = parsed
                  .filter((a: any) => a.category !== 'image')
                  .map((a: any) => ({ name: a.name, size: a.size || 0, type: a.type || '', content: a.content }));
                const imgs = parsed
                  .filter((a: any) => a.category === 'image')
                  .map((a: any) => ({ name: a.name, size: a.size || 0, type: a.type || '' }));
                if (files.length) setAttachedFiles((prev) => [...prev, ...files]);
                if (imgs.length) setAttachedImages((prev) => [...prev, ...imgs]);
              }
            } catch {}
            sessionStorage.removeItem('swarm_draft_attachments');
          }
        }
      } catch { /* ignore */ }

      const user = getStoredUser();
      const localId = readActiveDecompSessionId(user?.id);
      try {
        let session: any = null;
        let fit: FitMeterData | undefined;
        let summary: DecompTreeSummary | undefined;

        if (localId) {
          const res = await fetch(
            `/api/tasks/decompose?session=${encodeURIComponent(localId)}${
              user?.id ? `&userId=${encodeURIComponent(user.id)}` : ''
            }`,
            { cache: 'no-store', headers: authHeaders() },
          );
          if (res.ok) {
            const data = await res.json();
            if (data?.ok && data.session) {
              session = data.session;
              fit = data.fit;
              summary = data.summary;
            }
          }
        }

        if (!session && user?.id) {
          const res = await fetch(
            `/api/tasks/decompose?mine=1&userId=${encodeURIComponent(user.id)}`,
            { cache: 'no-store', headers: authHeaders() },
          );
          if (res.ok) {
            const data = await res.json();
            if (data?.ok && data.session) {
              session = data.session;
              fit = data.fit;
              summary = data.summary;
            }
          }
        }

        if (!cancelled && session?.nodes) {
          applySessionSnapshot(session, fit, summary);
          setProjectStatus('paused');
          setSwarmPaused(true);
          setChatMessages((prev) =>
            prev.length
              ? prev
              : [
                  {
                    sender: 'agent',
                    text: `Restored project “${session.project_title || 'Untitled'}” — pick up where you left off.`,
                    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                  },
                ],
          );
          if (session.id) void refreshWorkspace(session.id);
        }
      } catch {
        /* first visit / no session */
      }
    };
    void restore();
    return () => {
      cancelled = true;
    };
    // intentionally once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => { deepenAbort.current = true; }, []);

  const applySteeredSession = useCallback((session: any) => {
    if (!session?.nodes) return;
    setTreeNodes(flattenSessionToTree(session.nodes));
    setSwarmPaused(Boolean(session.paused));
    if (session.paused) setProjectStatus('paused');
    else if (projectStatus === 'paused') setProjectStatus('running');
    if (session.summary) setDecompSummary(session.summary);
    if (session.fit) setDecompFit(session.fit);
    if (session.id) setDecompSessionId(session.id);
  }, [projectStatus]);

  useEffect(() => {
    if (autostartRef.current) return;
    const goal = searchParams.get('goal')?.trim();
    if (!goal || searchParams.get('autostart') !== '1') return;
    autostartRef.current = true;
    const budgetParam = searchParams.get('budget');
    const budget = budgetParam ? timeBudgetFromLabel(budgetParam) : timeBudgetFromHours(1);
    void handleStartDecomposition({ project: goal, budget });
  }, [searchParams, handleStartDecomposition]);

  const missionHint = taskInput.trim()
    ? taskInput.trim().replace(/\s+/g, ' ').slice(0, 72)
    : undefined;

  const headerTrailing = (
    <>
      {(() => {
        const running = isExecuting || projectStatus === 'running';
        const st = running
          ? { dot: 'bg-st-running', text: 'text-fg-1', label: 'Running' }
          : projectStatus === 'paused'
            ? { dot: 'bg-st-paused', text: 'text-fg-2', label: 'Paused' }
            : projectStatus === 'completed'
              ? { dot: 'bg-st-done', text: 'text-fg-1', label: 'Done' }
              : { dot: 'bg-st-idle', text: 'text-fg-3', label: 'Idle' };
        return (
          <span className={`hidden md:inline-flex items-center gap-1.5 px-2 py-1 text-meta ${st.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} aria-hidden />
            {st.label}
          </span>
        );
      })()}
      {(treeNodes.length > 0 || taskInput || projectId) && (
        <button
          type="button"
          onClick={handleStartFresh}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-r-sm text-fg-3 text-meta hover:text-fg-1 hover:bg-white/[0.04] transition-colors duration-fast ease-out"
          title="Clear current mission"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">New</span>
        </button>
      )}
      <button
        type="button"
        onClick={() => setIsCanvasMaximized((v) => !v)}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-r-sm text-fg-3 text-meta hover:text-fg-1 hover:bg-white/[0.04] transition-colors duration-fast ease-out"
        title={isCanvasMaximized ? 'Restore view' : 'Maximize graph canvas'}
      >
        {isCanvasMaximized ? <Minimize2 className="w-3.5 h-3.5 text-accent" /> : <Maximize2 className="w-3.5 h-3.5" />}
      </button>
      <button
        type="button"
        onClick={() => setIsSteeringOpen((v) => !v)}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-r-sm text-fg-3 text-meta hover:text-fg-1 hover:bg-white/[0.04] transition-colors duration-fast ease-out"
        title={isSteeringOpen ? 'Hide steering drawer' : 'Show steering drawer'}
      >
        {isSteeringOpen ? <PanelRightClose className="w-3.5 h-3.5 text-accent" /> : <PanelRightOpen className="w-3.5 h-3.5" />}
      </button>
    </>
  );

  return (
    <ConsoleShell
      className="h-[100svh] overflow-hidden"
      missionHint={missionHint}
      trailing={headerTrailing}
    >
      <main className={`flex-1 min-h-0 grid transition-all duration-200 ${
        isCanvasMaximized
          ? 'grid-cols-1'
          : isSteeringOpen
            ? 'grid-cols-1 xl:grid-cols-[minmax(260px,20rem)_minmax(0,1fr)_minmax(280px,22rem)]'
            : 'grid-cols-1 xl:grid-cols-[minmax(260px,20rem)_minmax(0,1fr)]'
      }`}>
        <section className={`flex flex-col min-h-0 border-r border-line-1 bg-bg-1 overflow-y-auto ${isCanvasMaximized ? 'hidden' : 'flex'}`}>
          <div className="flex flex-col min-h-full">
            <div className="px-4 pt-4 pb-3">
              <div className="text-micro uppercase text-fg-3 mb-2">
                Objective
              </div>
              <UnifiedCommandBar
                mode={decompSessionId ? 'steer' : 'launch'}
                value={taskInput}
                onValueChange={setTaskInput}
                budget={timeBudget}
                onBudgetChange={setTimeBudget}
                budgetOptions={barBudgetOptions}
                disabled={isSubmitting}
                placeholder={
                  decompSessionId ? 'Steer the swarm…' : 'Describe a mission…'
                }
                onLaunch={handleBarLaunch}
                launchPending={isSubmitting || isExecuting}
                onAbort={handleAbortRun}
                onSteerSend={handleSteerSend}
                steerBusy={steerSending}
                className="w-full"
              />
            </div>

            <div className="px-4 pb-3">
              <input
                type="text"
                value={githubUrl}
                onChange={(e) => setGithubUrl(e.target.value)}
                placeholder="GitHub repo (optional)"
                className="w-full px-3 py-2 text-meta font-mono bg-bg-2 text-fg-1 placeholder:text-fg-4 border border-line-2 rounded-r-sm outline-none focus:border-line-3 focus-visible:shadow-focus transition-colors duration-fast ease-out"
              />
            </div>

            {/* Progress + runtime telemetry (inputs consolidated into the unified bar) */}
            <div className="px-4 pb-4 space-y-3">
              <DecompProgressBanner progress={decompProgress} />
              {decompFit && <FitMeter fit={decompFit} />}
              <TrajectoryTimeline className="mt-2" />
              {(runtimeInfo || orgSeats.length > 0) && (
                <p className="text-meta text-fg-3 tabular-nums" title={organizerNote || heatmapTop.slice(0, 4).join(' · ') || undefined}>
                  {runtimeInfo?.milestones?.length
                    ? `${runtimeInfo.milestones.filter((m) => m.status === 'passed').length}/${runtimeInfo.milestones.length} milestones`
                    : 'Runtime'}
                  {orgSeats.length > 0 && ` · ${orgSeats.length} agents`}
                  {orgSeats.some((x) => x.status === 'blocked') &&
                    ` · ${orgSeats.filter((x) => x.status === 'blocked').length} blocked`}
                  {blackboardCount > 0 && ` · ${blackboardCount} notes`}
                </p>
              )}
              {actionError && (
                <div className="flex items-start gap-2 text-meta text-st-failed border border-line-2 bg-bg-2 rounded-r-sm px-2.5 py-2">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  <span>{actionError}</span>
                </div>
              )}
            </div>
          </div>

        </section>

        {/* Center Panel: Main Graph */}
        <section className="flex flex-col min-h-0 overflow-hidden">
          <div className="flex flex-col h-full min-h-0 relative overflow-hidden">
            {treeNodes.length === 0 && !isSubmitting && !isExecuting ? (
              <div className="flex-1 min-h-0 flex flex-col relative overflow-hidden">
                <div className="flex-1 min-h-[20rem] overflow-hidden rounded-r-lg border border-line-2 bg-bg-0 m-3">
                  <ExecutionDagCanvas
                    className="h-full"
                    nodes={[]}
                    showDemoWhenEmpty
                    demoMission={taskInput || 'Ship a focused feature end-to-end'}
                    missionPrompt={taskInput || undefined}
                    outputLabel="Deliverable"
                    projectStatus="preview"
                    onNodeSelect={(n) =>
                      setSelectedDecompNode({
                        id: n.id,
                        type: (n.type as 'area' | 'task') || 'task',
                        label: n.label || n.description || n.id,
                        description: n.description || '',
                        priority: String(n.priority ?? 'medium'),
                        effort_minutes: n.effort_minutes,
                        depends_on: n.depends_on || [],
                        agent_class: n.agent_class || n.tags?.[0] || 'grunt',
                        model_tier: n.model_tier as DecompNode['model_tier'],
                        tools: n.tools as DecompNode['tools'],
                        acceptance_criteria: n.acceptance_criteria,
                        deliverable_path: n.deliverable_path,
                        status: (n.status as DecompNode['status']) || 'pending',
                        runCount: n.retry_count || 0,
                        children: [],
                        depth: n.depth || 0,
                        quality_score: n.quality_score,
                      })
                    }
                  />
                </div>
                <div className="shrink-0 flex flex-col items-center justify-center gap-4 text-center px-8 pb-6">
                <div className="space-y-2">
                  <p className="text-display text-fg-1">
                    One console. Goal in, swarm out.
                  </p>
                  <p className="text-body text-fg-3 max-w-md mx-auto">
                    Time-budgeted decomposition, live agents, workspace, and credits — same run, not two dashboards.
                  </p>
                </div>
                <ol className="flex flex-col sm:flex-row gap-3 text-left max-w-lg w-full">
                  {[
                    { n: '1', t: 'Write the goal', d: 'Left panel. Or tap a starter below.' },
                    { n: '2', t: 'Set the clock', d: 'Budget drives how deep the tree goes.' },
                    { n: '3', t: 'Send', d: 'Agents pick up the tasks as the graph fills.' },
                  ].map((s) => (
                    <li key={s.n} className="flex-1 rounded-r-md border border-line-2 bg-bg-2 px-3 py-2.5">
                      <div className="text-micro font-mono text-fg-3">{s.n}</div>
                      <div className="text-body text-fg-1">{s.t}</div>
                      <div className="text-meta text-fg-3 mt-0.5">{s.d}</div>
                    </li>
                  ))}
                </ol>
                <div className="flex flex-wrap justify-center gap-1.5">
                  {EXAMPLE_MISSIONS.map((ex) => (
                    <button
                      key={ex.label}
                      type="button"
                      onClick={() => {
                        const budget = timeBudgetFromLabel(ex.budget);
                        setTaskInput(ex.text);
                        setTimeBudget(budget);
                        void handleStartDecomposition({ project: ex.text, budget });
                      }}
                      className="px-2.5 py-1 rounded-r-sm border border-line-2 bg-bg-2 text-meta text-fg-2 hover:text-fg-1 hover:border-line-3 transition-colors duration-fast ease-out"
                    >
                      Run {ex.label}
                    </button>
                  ))}
                </div>
                </div>
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 p-3">
                {decompSummary && (
                  <div className="shrink-0">
                    <DecompSummaryPanel summary={decompSummary} />
                  </div>
                )}
                <div className="shrink-0 h-[calc(100svh-4.5rem)] min-h-[24rem] overflow-hidden rounded-r-lg border border-line-2 bg-bg-0">
                  <ExecutionDagCanvas
                    className="h-full"
                    nodes={treeNodes}
                    missionPrompt={taskInput || undefined}
                    outputLabel="Deliverable"
                    projectStatus={projectStatus}
                    timeRemaining={timeRemaining}
                    timeConsumed={timeConsumed}
                    selectedNodeId={selectedDecompNode?.id}
                    onNodeSelect={(n) =>
                      setSelectedDecompNode({
                        id: n.id,
                        type: (n.type as 'area' | 'task') || 'task',
                        label: n.label || n.description || n.id,
                        description: n.description || '',
                        priority: String(n.priority ?? 'medium'),
                        effort_minutes: n.effort_minutes,
                        depends_on: n.depends_on || [],
                        agent_class: n.agent_class || n.tags?.[0] || 'grunt',
                        model_tier: n.model_tier as DecompNode['model_tier'],
                        tools: n.tools as DecompNode['tools'],
                        acceptance_criteria: n.acceptance_criteria,
                        deliverable_path: n.deliverable_path,
                        status: (n.status as DecompNode['status']) || 'pending',
                        runCount: n.retry_count || 0,
                        children: [],
                        depth: n.depth || 0,
                        quality_score: n.quality_score,
                      })
                    }
                  />
                </div>

                <WorkspaceIDE
                  sessionId={decompSessionId || null}
                  initialPath={ideOpenPath}
                />

                {decompSessionId && treeNodes.length > 0 && (
                  <div className="h-[min(220px,26vh)] shrink-0 rounded-lg border border-[#27272a] overflow-hidden bg-[#0a0a0f]">
                    <ConsoleTerminal
                      sessionId={decompSessionId}
                      feedLines={missionTerminalLines}
                      className="h-full border-0 rounded-none"
                      onCommand={async (cmd) => {
                        if (cmd.startsWith('status')) {
                          return `mission: ${projectStatus} · nodes: ${treeNodes.length} · sse: ${missionTerminalLive ? 'live' : 'polling'}`;
                        }
                        return null;
                      }}
                    />
                  </div>
                )}

                {projectStatus === 'completed' && decompSessionId && workspaceFiles.length > 0 && (
                  <DeliverableReadyBanner
                    sessionId={decompSessionId}
                    files={workspaceFiles}
                    onOpenFile={(p) => setIdeOpenPath(p)}
                  />
                )}

                <AgentSandboxGrid
                  sessionId={decompSessionId || null}
                  projectId={projectId || null}
                  focusNodeId={selectedDecompNode?.id || null}
                  pollMs={projectStatus === 'running' ? 2000 : 5000}
                  onFocusNode={(nodeId) => {
                    const node = treeNodes.find((n) => n.id === nodeId);
                    if (node) setSelectedDecompNode(node as unknown as DecompNode);
                  }}
                  onOpenFile={(p) => setIdeOpenPath(p)}
                />
              </div>
            )}
            {selectedDecompNode && (
              <aside
                role="dialog"
                aria-label="Node inspector"
                className="absolute inset-y-0 right-0 z-20 w-[min(24rem,100%)] overflow-y-auto border-l border-line-2 bg-bg-1 shadow-e2 p-3"
              >
                <DecompNodeDetail
                  node={selectedDecompNode}
                  onClose={() => setSelectedDecompNode(null)}
                />
              </aside>
            )}
          </div>
        </section>

        {/* Right Panel: Steering & Context */}
        {!isCanvasMaximized && isSteeringOpen && (
          <section className="flex flex-col min-h-0 border-l border-line-1 bg-bg-1 overflow-hidden">
            <SteeringPanel
              sessionId={decompSessionId || null}
              projectId={projectId || null}
              selectedNodeId={selectedDecompNode?.id || null}
              paused={swarmPaused || projectStatus === 'paused'}
              messages={chatMessages}
              onMessages={setChatMessages}
              onSessionUpdate={applySteeredSession}
              sendViaParent={decompSessionId ? handleSteerSend : undefined}
              steerBusy={steerSending}
            />
          </section>
        )}

      </main>
      {paywall && (
        <PaywallPrompt
          variant="modal"
          creditsRequired={paywall.creditsRequired}
          creditsAvailable={paywall.creditsAvailable ?? balance?.credits}
          onDismiss={() => setPaywall(null)}
        />
      )}
    </ConsoleShell>
  );
}

export default function DecompPage() {
  return (
    <RequireAuth>
      <Suspense fallback={<div className="min-h-screen bg-bg-0" />}>
        <DecompPageInner />
      </Suspense>
    </RequireAuth>
  );
}
