'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  BaseEdge,
  getBezierPath,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Search, X } from 'lucide-react';
import { formatRoleLabel } from '@/lib/agentRoles';
import {
  DAG_STATUS_FILTERS,
  keyToFocusDelta,
  nextFocusIndex,
  orderForKeyboard,
  resolveDagHighlight,
  type DagStatusFilter,
} from '@/lib/dagFilters';
import { useReducedMotion } from 'framer-motion';
import StatusDot from '@/components/status/StatusDot';
import { isActiveStatus, statusMeta, toCanonical } from '@/lib/status';

export interface SwarmTreeNode {
  id: string;
  parent_id?: string | null;
  description: string;
  status: string;
  type?: string;
  depth?: number;
  path?: string;
  time_budget?: number;
  estimated_duration?: number;
  actual_duration?: number;
  quality_score?: number;
  retry_count?: number;
  priority?: number;
  assigned_worker_id?: string;
  assigned_provider?: string;
  last_pulse?: {
    action?: string;
    thinking_style?: string;
    confidence?: number;
    step?: number;
  } | null;
  tags?: string[];
  label?: string;
  agent_class?: string;
  model_tier?: string;
  tools?: string[];
  acceptance_criteria?: string[];
  depends_on?: string[];
  deliverable_path?: string;
  effort_minutes?: number;
  aobse?: {
    is_p_star?: boolean;
    chain_position?: number;
    value?: number;
    leverage?: number;
    cost?: number;
    net_yield?: number;
  };
}

interface SwarmDecompositionTreeProps {
  nodes: SwarmTreeNode[];
  projectStatus?: string;
  timeRemaining?: number;
  timeConsumed?: number;
  className?: string;
  selectedNodeId?: string | null;
  onNodeSelect?: (node: SwarmTreeNode) => void;
  /** Follow the active critical-path node with the camera */
  followActive?: boolean;
  /** User prompt shown as the top of the funnel */
  missionPrompt?: string;
  /** Bottom sink label (deliverable / output) */
  outputLabel?: string;
}

const BRANCH_COLORS: Record<string, string> = {
  research: '#a1a1aa',
  planning: '#d4d4d8',
  coding: '#e4e4e7',
  execution: '#a1a1aa',
  validation: '#71717a',
  data_ingestion: '#a1a1aa',
  architect: '#d4d4d8',
  specialist: '#a1a1aa',
  grunt: '#71717a',
  qa: '#a1a1aa',
  root: '#e4e4e7',
  default: '#a1a1aa',
};

// Status sets derived from the canonical status system (lib/status.ts).
// 'assigned' stays "active" here: in the DAG it means an agent has picked the task up.
const ACTIVE = {
  has: (s: string) => s === 'assigned' || isActiveStatus(toCanonical(s)),
};
const DONE = { has: (s: string) => toCanonical(s) === 'done' };
const FAILED = {
  has: (s: string) => {
    const c = toCanonical(s);
    return c === 'failed' || c === 'cancelled';
  },
};
const ST_RUNNING = statusMeta('running').colorVar;
const ST_DONE = statusMeta('done').colorVar;
const ST_FAILED = statusMeta('failed').colorVar;

function branchColor(node: SwarmTreeNode): string {
  const tag = node.agent_class || node.tags?.[0] || node.type || 'default';
  return BRANCH_COLORS[tag] || BRANCH_COLORS.default;
}

function progressFor(node: SwarmTreeNode): number {
  if (DONE.has(node.status)) return 100;
  if (FAILED.has(node.status)) return 0;
  if (ACTIVE.has(node.status)) {
    if (node.time_budget && node.actual_duration) {
      return Math.min(95, (node.actual_duration / node.time_budget) * 100);
    }
    return 45 + (node.priority || 5) * 3;
  }
  if (node.status === 'ready' || node.status === 'pending') return 8;
  if (node.status === 'paused') return 30;
  return 5;
}

/** Heat: green = under budget, amber = tight, rose = over */
function heatColor(node: SwarmTreeNode): string | null {
  const budget = node.time_budget || (node.effort_minutes ? node.effort_minutes * 60 : 0);
  const actual = node.actual_duration || 0;
  if (!budget || !ACTIVE.has(node.status)) return null;
  const ratio = actual / budget;
  if (ratio < 0.7) return '#86efac';
  if (ratio < 1.0) return '#fcd34d';
  return '#f87171';
}

function formatAgentRole(role: string): string {
  return formatRoleLabel(role);
}

function agentStatusForTask(taskStatus: string): string {
  if (ACTIVE.has(taskStatus)) return 'running';
  if (DONE.has(taskStatus)) return 'completed';
  if (FAILED.has(taskStatus)) return 'failed';
  if (taskStatus === 'paused') return 'paused';
  return 'assigned';
}

/** Attach orchestrator-assigned agent chips as child nodes under leaf tasks. */
function expandWithAgentNodes(nodes: SwarmTreeNode[]): SwarmTreeNode[] {
  const hasChildren = new Set<string>();
  for (const n of nodes) {
    if (n.parent_id) hasChildren.add(n.parent_id);
  }

  const agents: SwarmTreeNode[] = [];
  for (const n of nodes) {
    if (n.type === 'agent' || n.type === 'area') continue;
    if (hasChildren.has(n.id)) continue;
    const role = n.assigned_worker_id || (ACTIVE.has(n.status) || DONE.has(n.status) ? n.agent_class : null);
    if (!role) continue;
    // Only show agent chips once work is assigned / underway (keeps graph readable)
    if (!n.assigned_worker_id && !ACTIVE.has(n.status) && !DONE.has(n.status)) continue;

    const provider = n.assigned_provider;
    agents.push({
      id: `agent::${n.id}`,
      parent_id: n.id,
      type: 'agent',
      label: formatAgentRole(role),
      description: provider
        ? `${formatAgentRole(role)} via ${provider}`
        : `Orchestrator assigned: ${formatAgentRole(role)}`,
      status: agentStatusForTask(n.status),
      agent_class: role,
      assigned_worker_id: n.assigned_worker_id || role,
      assigned_provider: provider,
      depth: (n.depth || 0) + 1,
      tags: ['agent'],
      model_tier: n.model_tier,
      deliverable_path: provider,
      effort_minutes: undefined,
    });
  }

  return agents.length ? [...nodes, ...agents] : nodes;
}

function NeonChipNode({ data }: NodeProps) {
  const node = data.node as SwarmTreeNode;
  const selected = Boolean(data.selected);
  const onCritical = Boolean(data.onCritical);
  const dimmed = Boolean(data.dimmed);
  const isAgent = node.type === 'agent';
  const isMission = node.type === 'mission';
  const isOutput = node.type === 'output';
  const pct = progressFor(node);
  const isActive = ACTIVE.has(node.status);
  const isDone = DONE.has(node.status);
  const isFailed = FAILED.has(node.status);
  const heat = heatColor(node);
  const dimStyle = dimmed ? { opacity: 0.18, filter: 'saturate(0.4)' } : undefined;

  if (isMission || isOutput) {
    return (
      <div
        className="relative min-w-[280px] max-w-[400px] rounded-lg border cursor-default px-4 py-3 bg-[#141416]"
        style={{
          borderColor: isMission ? '#3f3f46' : 'rgba(52,211,153,0.35)',
          ...dimStyle,
        }}
      >
        {isMission ? (
          <Handle type="source" position={Position.Bottom} className="!bg-zinc-500 !w-2 !h-2 !border-0" />
        ) : (
          <Handle type="target" position={Position.Top} className="!bg-emerald-400/80 !w-2 !h-2 !border-0" />
        )}
        <div className="text-[10px] uppercase tracking-[0.12em] text-zinc-500 mb-1">
          {isMission ? 'Objective' : 'Deliverable'}
        </div>
        <p className="text-[13px] text-zinc-100 leading-snug font-medium line-clamp-4 tracking-[-0.02em]">
          {node.label || node.description}
        </p>
      </div>
    );
  }

  if (isAgent) {
    return (
      <div
        className={`relative min-w-[160px] max-w-[200px] rounded-md border bg-[#141416] cursor-pointer ${
          selected ? 'ring-1 ring-zinc-400/40' : ''
        }`}
        style={{
          borderColor: isActive ? '#52525b' : '#27272a',
          ...dimStyle,
        }}
      >
        <Handle type="target" position={Position.Top} className="!bg-zinc-500 !w-2 !h-2 !border-0" />
        <div className="px-3 py-2 text-center">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">Agent</div>
          <p className="text-[12px] text-zinc-200 font-medium truncate mt-0.5">
            {node.label || formatAgentRole(node.agent_class || 'worker')}
          </p>
        </div>
      </div>
    );
  }

  const isArea = node.type === 'area';

  return (
    <div
      className={`relative rounded-md border bg-[#141416] cursor-pointer ${
        isArea ? 'min-w-[240px] max-w-[300px]' : 'min-w-[220px] max-w-[280px]'
      } ${selected ? 'ring-1 ring-zinc-300/30' : ''}`}
      style={{
        borderColor: isFailed
          ? `color-mix(in srgb, ${ST_FAILED} 50%, transparent)`
          : heat
            ? heat
            : isDone
              ? `color-mix(in srgb, ${ST_DONE} 40%, transparent)`
              : isActive
                ? `color-mix(in srgb, ${ST_RUNNING} 45%, transparent)`
                : selected
                  ? '#3f3f46'
                  : '#27272a',
        boxShadow: onCritical ? 'inset 2px 0 0 #a1a1aa' : undefined,
        ...dimStyle,
      }}
    >
      <Handle type="target" position={Position.Top} className="!bg-zinc-600 !w-2 !h-2 !border-0" />
      <div className="px-3 py-2.5">
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="flex items-center gap-1.5 text-[11px] text-zinc-400 truncate">
            <StatusDot status={node.status === 'assigned' ? 'running' : node.status} size={7} />
            {isArea ? 'Area' : 'Task'}
            <span className="text-zinc-500">· {statusMeta(node.status === 'assigned' ? 'running' : node.status).label.toLowerCase()}</span>
          </span>
          <span className="text-[11px] text-zinc-400 tabular-nums">
            {node.effort_minutes != null ? `${node.effort_minutes}m` : ''}
          </span>
        </div>
        <p className="text-[13px] text-zinc-100 leading-snug line-clamp-2 tracking-[-0.02em]">
          {(node.label || node.description)?.slice(0, 100) || node.id.slice(0, 8)}
        </p>
        {node.last_pulse?.action && (
          <div className="mt-1.5 text-[10px] text-zinc-500 truncate">{node.last_pulse.action}</div>
        )}
        <div className="mt-2 h-0.5 rounded-full bg-white/10 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700 bg-zinc-300"
            style={{ width: `${pct}%`, opacity: isDone ? 1 : 0.7 }}
          />
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-zinc-600 !w-2 !h-2 !border-0" />
    </div>
  );
}

function NeonEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  data,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const kind = String((data as any)?.kind || 'branch'); // branch | dep | merge | spawn
  const active = Boolean(data?.active);
  const done = Boolean(data?.done);
  const onCp = Boolean(data?.onCritical);
  const dimmed = Boolean(data?.dimmed);
  const reducedMotion = useReducedMotion();
  const stroke =
    (style.stroke as string) ||
    (done
      ? ST_DONE
      : active
        ? ST_RUNNING
        : kind === 'dep'
          ? '#71717a'
          : onCp
            ? '#d4d4d8'
            : '#52525b');
  const pathId = `neon-flow-${id}`;
  const width =
    kind === 'merge' ? (done ? 3.5 : 2.5) : done ? 3 : active ? 2.75 : onCp ? 2.25 : kind === 'dep' ? 1.4 : 1.75;
  const opacity = dimmed
    ? 0.06
    : done
      ? 0.95
      : active
        ? 0.9
        : onCp
          ? 0.75
          : kind === 'dep'
            ? 0.45
            : 0.4;
  // pending = dotted; active/done = solid + glow; deps = short dashes; merge = long dashes until done
  const dash =
    done || active
      ? undefined
      : kind === 'dep'
        ? '3 7'
        : kind === 'merge'
          ? '12 8'
          : kind === 'spawn'
            ? '2 6'
            : onCp
              ? '8 6'
              : '5 8';

  return (
    <>
      {!done && !active && (
        <BaseEdge
          id={`${id}-ghost`}
          path={edgePath}
          style={{
            stroke,
            strokeWidth: width,
            opacity: 0.12,
            strokeDasharray: '6 8',
          }}
        />
      )}
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke,
          strokeWidth: width,
          opacity,
          strokeDasharray: dash,
          filter: undefined,
        }}
      />
      {active && !reducedMotion && (
        <>
          <path id={pathId} d={edgePath} fill="none" stroke="none" />
          {[0, 1, 2].map((i) => (
            <circle key={i} r={2.8} fill={stroke} opacity={0.95}>
              <animateMotion dur={`${1.35 + i * 0.3}s`} repeatCount="indefinite" begin={`${i * 0.3}s`}>
                <mpath href={`#${pathId}`} />
              </animateMotion>
            </circle>
          ))}
        </>
      )}
    </>
  );
}

const nodeTypes = { neonChip: NeonChipNode };
const edgeTypes = { neon: NeonEdge };

function layoutTree(nodes: SwarmTreeNode[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const byParent = new Map<string | null, SwarmTreeNode[]>();

  for (const n of nodes) {
    if (n.type === 'mission' || n.type === 'output') continue;
    const pid = n.parent_id || null;
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid)!.push(n);
  }

  const H_GAP = 340;
  const V_GAP = 200;

  function placeSubtree(id: string | null, depth: number, xStart: number): number {
    const children = byParent.get(id) || [];
    if (!children.length) return xStart;

    let x = xStart;
    for (const child of children) {
      const subWidth = placeSubtree(child.id, depth + 1, x);
      const cx = (x + subWidth - H_GAP) / 2;
      // depth 0 roots sit under the prompt (y starts at V_GAP)
      positions.set(child.id, { x: cx, y: (depth + 1) * V_GAP });
      x = subWidth + H_GAP;
    }
    return x;
  }

  const width = placeSubtree(null, 0, 0);
  const centerX = Math.max(0, (width - H_GAP) / 2);

  const mission = nodes.find((n) => n.type === 'mission');
  const output = nodes.find((n) => n.type === 'output');
  if (mission) positions.set(mission.id, { x: centerX, y: 0 });

  let maxY = 0;
  for (const p of positions.values()) maxY = Math.max(maxY, p.y);
  if (output) positions.set(output.id, { x: centerX, y: maxY + V_GAP * 1.35 });

  // If no children were placed, still center anchors
  if (!positions.size && mission) positions.set(mission.id, { x: 0, y: 0 });
  if (output && !positions.has(output.id)) positions.set(output.id, { x: 0, y: V_GAP * 2 });

  return positions;
}

/** Approximate critical path: deepest active/pending chain by effort */
function criticalPathIds(nodes: SwarmTreeNode[]): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parent_id) continue;
    if (!children.has(n.parent_id)) children.set(n.parent_id, []);
    children.get(n.parent_id)!.push(n.id);
  }

  const memo = new Map<string, { score: number; path: string[] }>();
  const dfs = (id: string): { score: number; path: string[] } => {
    if (memo.has(id)) return memo.get(id)!;
    const n = byId.get(id);
    if (!n) return { score: 0, path: [] };
    const effort = n.effort_minutes || (n.estimated_duration || 0) / 60 || 2;
    const kids = children.get(id) || [];
    if (!kids.length) {
      const r = { score: effort, path: [id] };
      memo.set(id, r);
      return r;
    }
    let best = { score: 0, path: [] as string[] };
    for (const c of kids) {
      const sub = dfs(c);
      if (sub.score > best.score) best = sub;
    }
    const r = { score: effort + best.score, path: [id, ...best.path] };
    memo.set(id, r);
    return r;
  };

  const roots = nodes.filter((n) => !n.parent_id);
  let bestPath: string[] = [];
  let bestScore = 0;
  for (const r of roots) {
    const res = dfs(r.id);
    if (res.score > bestScore) {
      bestScore = res.score;
      bestPath = res.path;
    }
  }
  return new Set(bestPath);
}

function CameraFollow({
  activeId,
  positions,
  enabled,
}: {
  activeId: string | null;
  positions: Map<string, { x: number; y: number }>;
  enabled: boolean;
}) {
  const { setCenter, getZoom } = useReactFlow();
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !activeId) return;
    if (last.current === activeId) return;
    const pos = positions.get(activeId);
    if (!pos) return;
    last.current = activeId;
    const zoom = Math.max(0.55, Math.min(1.05, getZoom()));
    setCenter(pos.x + 160, pos.y + 70, { zoom, duration: 650 });
  }, [activeId, positions, enabled, setCenter, getZoom]);

  return null;
}

function TreeCanvas({
  nodes: inputNodes,
  projectStatus = 'idle',
  timeRemaining = 0,
  timeConsumed = 0,
  className = '',
  selectedNodeId = null,
  onNodeSelect,
  followActive = true,
  missionPrompt,
  outputLabel = 'Deliverable',
}: SwarmDecompositionTreeProps) {
  const prevIds = useRef<Set<string>>(new Set());
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<DagStatusFilter>('all');
  const [query, setQuery] = useState('');
  const [focusIdx, setFocusIdx] = useState(-1);

  // Prompt → branches → leaves → output funnel (+ live agents only)
  const rawNodes = useMemo(() => {
    const agents = expandWithAgentNodes(inputNodes).filter((n) => n.type === 'agent');
    const liveAgents = agents.filter((n) => ACTIVE.has(n.status));
    const base = liveAgents.length ? [...inputNodes, ...liveAgents] : [...inputNodes];
    const anchors: SwarmTreeNode[] = [];
    if (missionPrompt?.trim()) {
      anchors.push({
        id: '__mission__',
        type: 'mission',
        parent_id: null,
        description: missionPrompt.trim(),
        label: missionPrompt.trim().slice(0, 180),
        status:
          projectStatus === 'completed'
            ? 'completed'
            : projectStatus === 'running'
              ? 'running'
              : 'pending',
      });
    }
    anchors.push({
      id: '__output__',
      type: 'output',
      parent_id: null,
      description: outputLabel,
      label: outputLabel,
      status: projectStatus === 'completed' ? 'completed' : 'pending',
    });
    return [...anchors, ...base];
  }, [inputNodes, missionPrompt, outputLabel, projectStatus]);
  const taskNodes = useMemo(
    () => rawNodes.filter((n) => n.type !== 'agent' && n.type !== 'mission' && n.type !== 'output'),
    [rawNodes]
  );


  // Detect newly spawned nodes (auto-deepen / inject / agent assign)
  useEffect(() => {
    const ids = new Set(rawNodes.map((n) => n.id));
    const spawned = new Set<string>();
    for (const id of ids) {
      if (!prevIds.current.has(id) && prevIds.current.size > 0) spawned.add(id);
    }
    prevIds.current = ids;
    if (spawned.size) {
      setNewIds(spawned);
      const t = setTimeout(() => setNewIds(new Set()), 1800);
      return () => clearTimeout(t);
    }
  }, [rawNodes]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const swarmNode = (node.data as { node: SwarmTreeNode }).node;
      if (swarmNode.type === 'mission' || swarmNode.type === 'output') return;
      onNodeSelect?.(swarmNode);
    },
    [onNodeSelect]
  );

  const critical = useMemo(() => criticalPathIds(taskNodes), [taskNodes]);

  // Focus mode: status filter + text query, resolved to a set of highlighted ids.
  const highlight = useMemo(
    () => resolveDagHighlight(taskNodes, { filter, query }),
    [taskNodes, filter, query]
  );
  const isFocusing = filter !== 'all' || query.trim().length > 0;
  const keyboardOrder = useMemo(
    () => orderForKeyboard(taskNodes, highlight.matchIds),
    [taskNodes, highlight.matchIds]
  );
  const { setCenter, getZoom } = useReactFlow();

  const focusNode = useCallback(
    (nodeId: string, positions: Map<string, { x: number; y: number }>) => {
      const pos = positions.get(nodeId);
      if (!pos) return;
      const zoom = Math.max(0.55, Math.min(1.3, getZoom() || 1));
      setCenter(pos.x + 140, pos.y + 60, { zoom, duration: 420 });
    },
    [setCenter, getZoom]
  );

  const activeFocusId = useMemo(() => {
    if (selectedNodeId) return selectedNodeId;
    const running = taskNodes.filter((n) => ACTIVE.has(n.status));
    const onCp = running.find((n) => critical.has(n.id));
    return onCp?.id || running[0]?.id || null;
  }, [taskNodes, selectedNodeId, critical]);

  const { flowNodes, flowEdges, positions } = useMemo(() => {
    if (!rawNodes.length) {
      return {
        flowNodes: [] as Node[],
        flowEdges: [] as Edge[],
        positions: new Map<string, { x: number; y: number }>(),
      };
    }

    const leafIds = new Set(
      (() => {
        const parents = new Set(
          rawNodes.filter((n) => n.parent_id).map((n) => n.parent_id as string)
        );
        return rawNodes
          .filter(
            (n) =>
              n.type !== 'mission' &&
              n.type !== 'output' &&
              n.type !== 'agent' &&
              !parents.has(n.id)
          )
          .map((n) => n.id);
      })()
    );

    const allDone =
      leafIds.size > 0 &&
      [...leafIds].every((id) => DONE.has(rawNodes.find((n) => n.id === id)?.status || ''));

    const nodesForLayout = rawNodes.map((n) =>
      n.id === '__output__'
        ? { ...n, status: allDone || projectStatus === 'completed' ? 'completed' : n.status }
        : n
    );

    const positions = layoutTree(nodesForLayout);
    const byId = new Map(nodesForLayout.map((n) => [n.id, n]));

    const flowNodes: Node[] = nodesForLayout.map((n) => ({
      id: n.id,
      type: 'neonChip',
      position: positions.get(n.id) || { x: 0, y: 0 },
      data: {
        node: n,
        selected: n.id === selectedNodeId,
        isNew: newIds.has(n.id),
        onCritical: critical.has(n.id),
        dimmed: isFocusing && !highlight.matchIds.has(n.id),
      },
      className: newIds.has(n.id) ? 'neon-node-enter' : undefined,
      draggable: n.type !== 'mission' && n.type !== 'output',
    }));

    const hasMission = nodesForLayout.some((n) => n.id === '__mission__');
    const roots = nodesForLayout.filter(
      (n) => !n.parent_id && n.type !== 'mission' && n.type !== 'output' && n.type !== 'agent'
    );

    const parentEdges: Edge[] = nodesForLayout
      .filter((n) => n.parent_id && n.type !== 'agent')
      .map((n) => {
        const color = branchColor(n);
        const childDone = DONE.has(n.status);
        const active =
          ACTIVE.has(n.status) || ACTIVE.has(byId.get(n.parent_id!)?.status || '');
        const onCp = critical.has(n.id) && critical.has(n.parent_id!);
        const spawned = newIds.has(n.id);
        return {
          id: `p-${n.parent_id}-${n.id}`,
          source: n.parent_id!,
          target: n.id,
          type: 'neon',
          animated: false,
          data: {
            kind: spawned ? 'spawn' : 'branch',
            active: active && !childDone,
            done: childDone,
            onCritical: onCp,
            dimmed: isFocusing && !highlight.matchIds.has(n.id),
          },
          style: {
            stroke: childDone ? '#a1a1aa' : onCp ? '#d4d4d8' : color,
          },
        };
      });

    // Prompt fans into top-level branches
    const promptEdges: Edge[] = hasMission
      ? roots.map((r) => ({
          id: `prompt-${r.id}`,
          source: '__mission__',
          target: r.id,
          type: 'neon',
          data: {
            kind: 'branch',
            active: ACTIVE.has(r.status),
            done: DONE.has(r.status),
            onCritical: critical.has(r.id),
            dimmed: isFocusing && !highlight.matchIds.has(r.id),
          },
          style: { stroke: '#94a3b8' },
        }))
      : [];

    // Cross-branch create/merge deps (dotted)
    const depEdges: Edge[] = [];
    for (const n of nodesForLayout) {
      for (const dep of n.depends_on || []) {
        if (!byId.has(dep)) continue;
        depEdges.push({
          id: `d-${dep}-${n.id}`,
          source: dep,
          target: n.id,
          type: 'neon',
          data: {
            kind: 'dep',
            active: ACTIVE.has(n.status),
            done: DONE.has(n.status) && DONE.has(byId.get(dep)?.status || ''),
            dimmed:
              isFocusing &&
              !highlight.matchIds.has(n.id) &&
              !highlight.matchIds.has(dep),
          },
          style: { stroke: '#c084fc' },
        });
      }
    }

    // Leaves converge into output
    const mergeEdges: Edge[] = [...leafIds].map((id) => {
      const n = byId.get(id)!;
      const done = DONE.has(n.status);
      return {
        id: `m-${id}-output`,
        source: id,
        target: '__output__',
        type: 'neon',
        data: {
          kind: 'merge',
          active: ACTIVE.has(n.status),
          done,
          dimmed: isFocusing && !highlight.matchIds.has(id),
        },
        style: { stroke: done ? '#34d399' : '#52525b' },
      };
    });

    return {
      flowNodes,
      flowEdges: [...promptEdges, ...parentEdges, ...depEdges, ...mergeEdges],
      positions,
    };
  }, [rawNodes, selectedNodeId, newIds, critical, projectStatus, isFocusing, highlight.matchIds]);

  // Reset the keyboard cursor whenever the visible set changes.
  useEffect(() => {
    setFocusIdx(-1);
  }, [filter, query]);

  const moveFocus = useCallback(
    (delta: number) => {
      if (!keyboardOrder.length) return;
      const next = nextFocusIndex(keyboardOrder.length, focusIdx, delta);
      if (next < 0) return;
      setFocusIdx(next);
      const id = keyboardOrder[next];
      const target = taskNodes.find((n) => n.id === id);
      if (target) {
        onNodeSelect?.(target);
        focusNode(id, positions);
      }
    },
    [keyboardOrder, focusIdx, taskNodes, onNodeSelect, focusNode, positions]
  );

  const onTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isFocusing) {
          setFilter('all');
          setQuery('');
          setFocusIdx(-1);
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'Enter' && focusIdx >= 0) {
        const id = keyboardOrder[focusIdx];
        const target = taskNodes.find((n) => n.id === id);
        if (target) {
          onNodeSelect?.(target);
          focusNode(id, positions);
          e.preventDefault();
        }
        return;
      }
      const delta = keyToFocusDelta(e.key);
      if (delta === null) return;
      // Ignore bare j/k while typing in the search field.
      const isTextField =
        e.target instanceof HTMLElement &&
        (e.target.tagName === 'INPUT' || e.target.isContentEditable);
      if (isTextField && (e.key === 'j' || e.key === 'k')) return;
      e.preventDefault();
      moveFocus(delta);
    },
    [isFocusing, focusIdx, keyboardOrder, taskNodes, onNodeSelect, focusNode, positions, moveFocus]
  );

  const completed = taskNodes.filter((n) => DONE.has(n.status)).length;
  const total = taskNodes.length;
  const overallPct = total ? (completed / total) * 100 : 0;
  const activeCount = taskNodes.filter((n) => ACTIVE.has(n.status)).length;

  const formatTime = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return [h, m, s].map((v) => v.toString().padStart(2, '0')).join(':');
  };

  if (!taskNodes.length) {
    return (
      <div className={`flex flex-col items-center justify-center h-full text-zinc-600 ${className}`}>
        <p className="text-[13px] text-zinc-400">Graph idle</p>
        <p className="text-[12px] mt-1 text-zinc-600">Send an objective to populate the tree</p>
      </div>
    );
  }

  return (
    <div className={`relative h-full flex flex-col ${className}`}>
      <style>{`
        .neon-chip-pulse {
          animation: neon-chip-glow 1.6s ease-in-out infinite;
        }
        @keyframes neon-chip-glow {
          0%, 100% { filter: brightness(1); }
          50% { filter: brightness(1.25); }
        }
        .neon-ring {
          pointer-events: none;
          position: absolute;
          inset: -6px;
          border-radius: 10px;
          border: 1px solid;
          opacity: 0.55;
          animation: neon-ring-pulse 1.8s ease-out infinite;
        }
        @keyframes neon-ring-pulse {
          0% { transform: scale(0.96); opacity: 0.7; }
          100% { transform: scale(1.12); opacity: 0; }
        }
        .neon-chip-spawn {
          animation: neon-spawn 0.7s cubic-bezier(0.22, 1, 0.36, 1);
        }
        @keyframes neon-spawn {
          0% { transform: scale(0.4); opacity: 0; filter: brightness(2); }
          100% { transform: scale(1); opacity: 1; filter: brightness(1); }
        }
        .neon-chip-critical {
          outline: 1px solid rgba(251, 191, 36, 0.45);
          outline-offset: 3px;
        }
        .neon-chip-selected {
          transform: translateY(-1px);
        }
        .neon-chip-done {
          filter: saturate(1.15) brightness(1.05);
        }
        .neon-chip-done:hover {
          filter: saturate(1.2) brightness(1.1);
        }
        .react-flow__edge-path {
          transition: stroke 0.4s, opacity 0.4s, stroke-width 0.4s;
        }
      `}</style>

      <div className="absolute top-3 left-3 right-3 z-10 flex flex-col gap-2 pointer-events-none">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded text-[11px] text-zinc-400 border border-[#27272a] bg-[#141416]/90">
              {projectStatus}
            </span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-zinc-500 bg-[#141416]/90 px-2.5 py-1 rounded-md border border-[#27272a]">
            <span>{completed}/{total} done</span>
            <span>{activeCount} active</span>
            <span>{formatTime(timeRemaining)} left</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-3 text-[10px] text-zinc-600 bg-[#141416]/80 w-fit px-2.5 py-1 rounded-md border border-[#27272a]">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-5 border-t border-dashed border-zinc-500" /> branch
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-5 border-t-2 border-zinc-400" /> live/done
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-5 border-t border-dotted border-zinc-500" /> dep
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-5 border-t border-dashed border-emerald-500/60" /> output
          </span>
        </div>

        {/* DAG control rail — status focus, search, keyboard traversal */}
        <div
          role="toolbar"
          aria-label="Graph focus controls"
          className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-md border border-[#27272a] bg-[#141416]/95 px-2 py-1.5 w-fit max-w-full"
        >
          <div className="flex items-center gap-0.5" role="group" aria-label="Filter by status">
            {DAG_STATUS_FILTERS.map((f) => {
              const active = filter === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  data-testid={`dag-filter-${f.id}`}
                  aria-pressed={active}
                  onClick={() => setFilter(f.id)}
                  className={`px-2 py-0.5 rounded text-[10px] uppercase tracking-wider transition-colors ${
                    active
                      ? 'bg-zinc-100 text-zinc-900 font-medium'
                      : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.05]'
                  }`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>

          <span className="h-4 w-px bg-[#27272a]" aria-hidden />

          <label className="flex items-center gap-1.5 text-zinc-500 focus-within:text-zinc-200">
            <Search className="h-3 w-3 shrink-0" aria-hidden />
            <span className="sr-only">Search nodes</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Node…"
              aria-label="Search graph nodes"
              className="w-[7.5rem] bg-transparent text-[11px] text-zinc-200 placeholder:text-zinc-600 outline-none"
            />
          </label>

          <span
            data-testid="dag-match-count"
            className="text-[10px] font-mono tabular-nums text-zinc-500"
            title="Matching nodes / total nodes"
          >
            {highlight.count}/{highlight.total}
          </span>

          {isFocusing ? (
            <button
              type="button"
              onClick={() => {
                setFilter('all');
                setQuery('');
              }}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06]"
              aria-label="Clear graph focus"
            >
              <X className="h-3 w-3" aria-hidden /> clear
            </button>
          ) : null}

          <span className="hidden sm:inline text-[10px] text-zinc-600 font-mono">
            ↑↓ move · ⏎ open · esc clear
          </span>
        </div>
      </div>

      <div
        className="flex-1 overflow-hidden border-0 bg-[#0c0c0d] outline-none"
        style={{ minHeight: 620 }}
        tabIndex={0}
        onKeyDown={onTreeKeyDown}
        aria-label="Execution graph canvas"
        data-testid="swarm-dag-canvas"
      >
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onNodeClick}
          fitView
          fitViewOptions={{ padding: 0.18, maxZoom: 1.15, minZoom: 0.12 }}
          proOptions={{ hideAttribution: true }}
          nodesDraggable
          nodesConnectable={false}
          panOnScroll
          zoomOnScroll
          panOnDrag
          selectionOnDrag={false}
          minZoom={0.02}
          maxZoom={4.0}
          defaultViewport={{ x: 0, y: 0, zoom: 0.95 }}
          zoomOnPinch
          zoomOnDoubleClick
        >
          <Background color="#27272a" gap={28} size={1} />
          <Controls
            showInteractive={false}
            position="bottom-right"
            className="!bg-[#141416] !border-[#27272a] !shadow-none [&>button]:!bg-[#1a1a1d] [&>button]:!border-[#27272a] [&>button]:!text-zinc-400 [&>button]:!w-7 [&>button]:!h-7"
          />
          <MiniMap
            className="!bg-[#141416] !border-[#27272a] !w-[140px] !h-[96px]"
            pannable
            zoomable
            nodeColor={(n) => {
              const node = (n.data as { node: SwarmTreeNode }).node;
              if (ACTIVE.has(node.status)) return ST_RUNNING;
              if (DONE.has(node.status)) return ST_DONE;
              if (FAILED.has(node.status)) return ST_FAILED;
              return '#3f3f46';
            }}
            maskColor="rgba(12,12,13,0.75)"
          />
          <CameraFollow
            activeId={activeFocusId}
            positions={positions}
            enabled={followActive && (projectStatus === 'running' || activeCount > 0)}
          />
        </ReactFlow>
      </div>
    </div>
  );
}

export default function SwarmDecompositionTree(props: SwarmDecompositionTreeProps) {
  return (
    <ReactFlowProvider>
      <TreeCanvas {...props} />
    </ReactFlowProvider>
  );
}
