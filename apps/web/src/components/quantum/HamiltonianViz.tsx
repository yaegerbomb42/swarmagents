'use client';

import { useEffect, useRef } from 'react';
import { Atom } from 'lucide-react';

export type HamiltonianNode = {
  id: string;
  label: string;
  x: number;
  y: number;
  energy: number;
};

export type HamiltonianVizProps = {
  nodes: HamiltonianNode[];
  edges: Array<{ from: string; to: string; energy: number }>;
  activeNodeId?: string;
  totalEnergy?: number;
  className?: string;
};

const NODE_RADIUS = 22;

export default function HamiltonianViz({
  nodes,
  edges,
  activeNodeId,
  totalEnergy,
  className = '',
}: HamiltonianVizProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || nodes.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const byId = new Map(nodes.map((n) => [n.id, n]));

    // Energy field gradient
    const grad = ctx.createRadialGradient(w * 0.5, h * 0.5, 10, w * 0.5, h * 0.5, w * 0.55);
    grad.addColorStop(0, 'rgba(34, 211, 238, 0.12)');
    grad.addColorStop(1, 'rgba(6, 6, 26, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Edges
    for (const edge of edges) {
      const a = byId.get(edge.from);
      const b = byId.get(edge.to);
      if (!a || !b) continue;
      const intensity = Math.min(1, edge.energy / 3);
      ctx.strokeStyle = `rgba(168, 85, 247, ${0.25 + intensity * 0.45})`;
      ctx.lineWidth = 1 + intensity;
      ctx.beginPath();
      ctx.moveTo(a.x * w, a.y * h);
      ctx.lineTo(b.x * w, b.y * h);
      ctx.stroke();
    }

    // Nodes
    for (const node of nodes) {
      const cx = node.x * w;
      const cy = node.y * h;
      const active = node.id === activeNodeId;
      const glow = ctx.createRadialGradient(cx, cy, 2, cx, cy, NODE_RADIUS * 1.8);
      glow.addColorStop(0, active ? 'rgba(34, 211, 238, 0.55)' : 'rgba(168, 85, 247, 0.25)');
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, NODE_RADIUS * 1.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = active ? 'rgba(8, 20, 40, 0.95)' : 'rgba(12, 12, 32, 0.9)';
      ctx.strokeStyle = active ? 'rgba(34, 211, 238, 0.85)' : 'rgba(255,255,255,0.15)';
      ctx.lineWidth = active ? 2 : 1;
      ctx.beginPath();
      ctx.arc(cx, cy, NODE_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = active ? '#a5f3fc' : 'rgba(255,255,255,0.75)';
      ctx.font = '600 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(node.label.toUpperCase().slice(0, 8), cx, cy);
    }
  }, [nodes, edges, activeNodeId]);

  return (
    <section
      data-testid="hamiltonian-viz"
      className={`relative rounded-xl border border-white/10 bg-[#040414]/90 overflow-hidden ${className}`}
      aria-label="Hamiltonian energy landscape"
    >
      <header className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-3 py-2 pointer-events-none">
        <div className="flex items-center gap-2">
          <Atom className="h-4 w-4 text-purple-300" aria-hidden />
          <span className="text-[11px] font-medium text-white/85">Energy Landscape</span>
        </div>
        {typeof totalEnergy === 'number' ? (
          <span className="text-[10px] font-mono text-cyan-300/80">E={totalEnergy.toFixed(2)}</span>
        ) : null}
      </header>
      <canvas ref={canvasRef} className="w-full h-full min-h-[12rem]" />
    </section>
  );
}

export function planToHamiltonianGraph(
  actions: string[],
  activeIndex: number,
): { nodes: HamiltonianNode[]; edges: HamiltonianVizProps['edges'] } {
  const unique = [...new Set(actions)];
  const nodes: HamiltonianNode[] = unique.map((label, i) => ({
    id: label,
    label,
    x: 0.12 + (i / Math.max(1, unique.length - 1)) * 0.76,
    y: 0.35 + (i % 2) * 0.3,
    energy: i * 0.5,
  }));
  const edges: HamiltonianVizProps['edges'] = [];
  for (let i = 0; i < actions.length - 1; i += 1) {
    edges.push({
      from: actions[i],
      to: actions[i + 1],
      energy: (i + 1) * 0.5,
    });
  }
  if (activeIndex >= 0 && activeIndex < actions.length) {
    const active = actions[activeIndex];
    const node = nodes.find((n) => n.id === active);
    if (node) node.energy += 1;
  }
  return { nodes, edges };
}
