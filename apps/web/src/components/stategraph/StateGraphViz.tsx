'use client';

import React from 'react';
import type { StateGraphStatus } from './api';

type NodeKey = 'pm' | 'coder' | 'verifier' | 'complete';

const NODE_LABELS: Record<NodeKey, string> = {
  pm: 'PM',
  coder: 'Coder',
  verifier: 'Verifier',
  complete: 'Complete',
};

const NODE_COLORS: Record<NodeKey, { active: string; done: string; pending: string; text: string }> = {
  pm:       { active: '#f59e0b', done: '#b45309', pending: '#3f3f46', text: '#fef3c7' },
  coder:    { active: '#06b6d4', done: '#0e7490', pending: '#3f3f46', text: '#cffafe' },
  verifier: { active: '#a78bfa', done: '#7c3aed', pending: '#3f3f46', text: '#ede9fe' },
  complete: { active: '#10b981', done: '#047857', pending: '#3f3f46', text: '#d1fae5' },
};

function nodeOrder(n: NodeKey): number {
  switch (n) {
    case 'pm': return 0;
    case 'coder': return 1;
    case 'verifier': return 2;
    case 'complete': return 3;
  }
}

function deriveNodeStates(status: StateGraphStatus | null): Record<NodeKey, 'pending' | 'active' | 'done'> {
  const out: Record<NodeKey, 'pending' | 'active' | 'done'> = {
    pm: 'pending', coder: 'pending', verifier: 'pending', complete: 'pending',
  };
  if (!status) return out;

  const history = status.node_history ?? [];
  const entered = new Set<string>();
  const exited = new Set<string>();
  for (const ev of history) {
    if (ev.node === 'graph') continue;
    if (ev.event === 'enter') entered.add(ev.node);
    if (ev.event === 'exit') exited.add(ev.node);
  }
  const cur = status.current_node as NodeKey | 'queued' | 'fallback';
  const curOrder = cur === 'queued' || cur === 'fallback' ? -1 : nodeOrder(cur as NodeKey);

  (['pm', 'coder', 'verifier', 'complete'] as NodeKey[]).forEach((k) => {
    if (status.status === 'complete') {
      out[k] = 'done';
    } else if (k === cur) {
      out[k] = 'active';
    } else if (exited.has(k) && curOrder > nodeOrder(k)) {
      out[k] = 'done';
    } else if (entered.has(k) && k === cur) {
      out[k] = 'active';
    }
  });
  return out;
}

export default function StateGraphViz({
  status,
  selected,
  onSelect,
}: {
  status: StateGraphStatus | null;
  selected: NodeKey | null;
  onSelect: (n: NodeKey) => void;
}) {
  const states = deriveNodeStates(status);
  const nodes: NodeKey[] = ['pm', 'coder', 'verifier', 'complete'];

  const W = 720;
  const H = 200;
  const NODE_W = 110;
  const NODE_H = 56;
  const gap = (W - nodes.length * NODE_W) / (nodes.length + 1);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full max-w-3xl mx-auto"
      role="img"
      aria-label="state graph"
    >
      {/* edges */}
      {nodes.slice(0, -1).map((k, i) => {
        const x1 = gap * (i + 1) + NODE_W * i + NODE_W;
        const x2 = gap * (i + 2) + NODE_W * (i + 1);
        const y = H / 2;
        const edgeDone = states[nodes[i + 1] as NodeKey] !== 'pending';
        return (
          <g key={`e-${k}`}>
            <line
              x1={x1}
              y1={y}
              x2={x2 - 8}
              y2={y}
              stroke={edgeDone ? '#10b981' : '#3f3f46'}
              strokeWidth={2}
              strokeDasharray={edgeDone ? '0' : '4 4'}
            />
            <polygon
              points={`${x2 - 8},${y - 4} ${x2},${y} ${x2 - 8},${y + 4}`}
              fill={edgeDone ? '#10b981' : '#3f3f46'}
            />
          </g>
        );
      })}

      {/* verifier -> coder retry loop (dashed) */}
      <path
        d={`M ${gap * 3 + NODE_W * 2 + NODE_W / 2} ${H / 2 + NODE_H / 2}
            C ${gap * 3 + NODE_W * 2 + NODE_W / 2} ${H - 30},
              ${gap * 2 + NODE_W * 1 + NODE_W / 2} ${H - 30},
              ${gap * 2 + NODE_W * 1 + NODE_W / 2} ${H / 2 + NODE_H / 2}`}
        stroke="#ef4444"
        strokeWidth={1.5}
        fill="none"
        strokeDasharray="3 4"
        opacity={0.6}
      />
      <text x={W / 2} y={H - 12} textAnchor="middle" fontSize={10} fill="#ef4444" opacity={0.7}>
        retry on failure
      </text>

      {/* nodes */}
      {nodes.map((k, i) => {
        const x = gap * (i + 1) + NODE_W * i;
        const y = H / 2 - NODE_H / 2;
        const st = states[k];
        const colors = NODE_COLORS[k];
        const fill = st === 'active' ? colors.active : st === 'done' ? colors.done : colors.pending;
        const stroke = selected === k ? '#fff' : st === 'active' ? colors.active : '#52525b';
        return (
          <g
            key={k}
            transform={`translate(${x},${y})`}
            onClick={() => onSelect(k)}
            style={{ cursor: 'pointer' }}
          >
            <rect
              width={NODE_W}
              height={NODE_H}
              rx={10}
              fill={fill}
              fillOpacity={st === 'active' ? 0.35 : st === 'done' ? 0.5 : 0.2}
              stroke={stroke}
              strokeWidth={selected === k ? 2 : st === 'active' ? 2 : 1}
            />
            <text
              x={NODE_W / 2}
              y={NODE_H / 2 - 4}
              textAnchor="middle"
              fontSize={13}
              fontWeight={600}
              fill={st === 'pending' ? '#a1a1aa' : colors.text}
            >
              {NODE_LABELS[k]}
            </text>
            <text
              x={NODE_W / 2}
              y={NODE_H / 2 + 12}
              textAnchor="middle"
              fontSize={10}
              fill={st === 'pending' ? '#71717a' : colors.text}
              opacity={0.85}
            >
              {st === 'active' ? '● running' : st === 'done' ? '✓ done' : '○ pending'}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
