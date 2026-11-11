'use client';

import { useMemo, useState } from 'react';
import { resolveRoleId, type HierarchyAgent } from '@/lib/swarmHierarchy';
import SwarmCanvas3D from '../topology/SwarmCanvas3D';

interface SandboxGraphPaneProps {
  agentId: string;
  agentLabel: string;
  archetype?: string;
  childIds?: string[];
  parentId?: string | null;
  connected?: boolean;
}

function buildAgents({
  agentId,
  agentLabel,
  archetype,
  childIds,
  parentId,
}: SandboxGraphPaneProps): HierarchyAgent[] {
  const rootRole = resolveRoleId(archetype);
  const agents: HierarchyAgent[] = [
    {
      id: agentId,
      roleId: rootRole,
      parentId: parentId ?? null,
      status: 'running',
      label: agentLabel,
      activity: childIds?.length ? 'communicating' : 'working',
      live: true,
    },
  ];

  for (const childId of childIds ?? []) {
    agents.push({
      id: childId,
      roleId: resolveRoleId(undefined),
      parentId: agentId,
      status: 'running',
      label: childId.length > 18 ? `${childId.slice(0, 16)}…` : childId,
      activity: 'working',
      live: true,
    });
  }

  if (parentId) {
    const hasParent = agents.some((a) => a.id === parentId);
    if (!hasParent) {
      agents.unshift({
        id: parentId,
        roleId: 'architect',
        parentId: null,
        status: 'running',
        label: 'Parent',
        activity: 'communicating',
        live: false,
      });
    }
  }

  return agents;
}

export default function SandboxGraphPane(props: SandboxGraphPaneProps) {
  const { agentLabel, childIds, connected = true } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const agents = useMemo(() => buildAgents(props), [props]);

  return (
    <div className="w-full h-full relative flex flex-col bg-[#040414] min-h-[320px]">
      <SwarmCanvas3D
        agents={agents}
        connected={connected}
        className="flex-1"
        onSelectAgent={setSelectedId}
      />
      <div
        className="shrink-0 border-t border-white/[0.06] px-3 py-2 text-[9px] font-mono text-zinc-500 flex justify-between gap-2"
        style={{ background: 'rgba(6,6,26,0.85)', backdropFilter: 'blur(8px)' }}
      >
        <span>
          {agents.length} node{agents.length === 1 ? '' : 's'} · {childIds?.length ?? 0} delegate
          {(childIds?.length ?? 0) === 1 ? '' : 's'}
        </span>
        <span className="text-cyan-400/80 truncate">
          {selectedId ? `selected: ${selectedId}` : agentLabel}
        </span>
      </div>
    </div>
  );
}
