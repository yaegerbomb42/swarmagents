'use client';

import SwarmDecompositionTree, {
  type SwarmTreeNode,
} from '@/components/swarm/SwarmDecompositionTree';
import { buildDemoDagNodes } from './demoNodes';
import StatusDot from '@/components/status/StatusDot';
import { statusMeta, type CanonicalStatus } from '@/lib/status';

export type ExecutionDagStatus = 'pending' | 'running' | 'done' | 'failed';

const STATUS_LEGEND: ReadonlyArray<{ id: ExecutionDagStatus; canonical: CanonicalStatus }> = [
  { id: 'pending', canonical: 'queued' },
  { id: 'running', canonical: 'running' },
  { id: 'done', canonical: 'done' },
  { id: 'failed', canonical: 'failed' },
];

export type ExecutionDagCanvasProps = {
  nodes: SwarmTreeNode[];
  projectStatus?: string;
  timeRemaining?: number;
  timeConsumed?: number;
  className?: string;
  selectedNodeId?: string | null;
  onNodeSelect?: (node: SwarmTreeNode) => void;
  followActive?: boolean;
  missionPrompt?: string;
  outputLabel?: string;
  /** When true and nodes are empty, render a static demo DAG (idle studio preview). */
  showDemoWhenEmpty?: boolean;
  demoMission?: string;
};

/**
 * LangGraph-style execution DAG surface for Decomposition Studio.
 * Thin shell over SwarmDecompositionTree: status legend + optional idle demo.
 */
export default function ExecutionDagCanvas({
  nodes,
  showDemoWhenEmpty = false,
  demoMission,
  missionPrompt,
  className,
  ...rest
}: ExecutionDagCanvasProps) {
  const usingDemo = showDemoWhenEmpty && nodes.length === 0;
  const graphNodes = usingDemo ? buildDemoDagNodes(demoMission || missionPrompt) : nodes;

  return (
    <div
      className={`relative flex h-full min-h-0 flex-col bg-[#050508] ${className || ''}`}
      data-testid="execution-dag-canvas"
      data-demo={usingDemo ? 'true' : 'false'}
    >
      <div
        role="status"
        aria-label="Step status legend"
        className="pointer-events-none absolute bottom-3 left-3 z-10 flex items-center gap-2 rounded-md border border-white/[0.06] px-2 py-1"
        style={{ background: 'rgba(8,10,18,0.72)' }}
      >
        {STATUS_LEGEND.map((s) => (
          <span
            key={s.id}
            className="inline-flex items-center gap-1 text-[11px] text-zinc-400"
          >
            <StatusDot status={s.canonical} size={7} animate={false} />
            {statusMeta(s.canonical).label}
          </span>
        ))}
        {usingDemo ? (
          <span className="ml-1 font-mono text-[10px] tabular-nums text-cyan-400/80">preview</span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1">
        <SwarmDecompositionTree
          {...rest}
          className="h-full"
          nodes={graphNodes}
          missionPrompt={missionPrompt}
          projectStatus={usingDemo ? 'preview' : rest.projectStatus}
        />
      </div>
    </div>
  );
}

export { buildDemoDagNodes };
