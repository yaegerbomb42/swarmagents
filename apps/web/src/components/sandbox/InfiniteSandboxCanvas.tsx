'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Layers,
  Search,
  ZoomIn,
  ZoomOut,
  Maximize,
  Filter,
  Users,
  Compass,
  Sparkles,
} from 'lucide-react';
import type { AgentSandbox } from '@/lib/sandboxTypes';
import { AGENT_ROLES } from '@/lib/agentRoles';
import UnifiedAgentSandbox from './UnifiedAgentSandbox';

interface InfiniteSandboxCanvasProps {
  sandboxes: AgentSandbox[];
  onSandboxUpdate?: (agentId: string, patch: Partial<AgentSandbox>) => void;
  className?: string;
  fleetReview?: boolean;
  sessionId?: string | null;
}

const CARD_W = 540;
const CARD_H = 460;
const H_GAP = 60;
const V_GAP = 120;

export default function InfiniteSandboxCanvas({
  sandboxes = [],
  onSandboxUpdate,
  className = '',
  fleetReview = false,
  sessionId = null,
}: InfiniteSandboxCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [viewport, setViewport] = useState({ x: 100, y: 80, zoom: 0.75 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [filterRole, setFilterRole] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [containerSize, setContainerSize] = useState({ width: 1200, height: 800 });

  // Update container dimensions
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Compute Symmetric 2D Spatial Layout (Peers in balanced root clusters, subagents beneath)
  const computedLayout = useMemo(() => {
    const positions: Record<string, { x: number; y: number; level: number }> = {};
    const peers = sandboxes.filter((s) => !s.parentId);
    const subagents = sandboxes.filter((s) => Boolean(s.parentId));

    // Arrange Peers symmetrically across top columns
    const cols = Math.max(3, Math.ceil(Math.sqrt(peers.length || 1)));
    peers.forEach((peer, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      positions[peer.id] = {
        x: col * (CARD_W + H_GAP),
        y: row * (CARD_H + V_GAP),
        level: 0,
      };
    });

    // Arrange Subagents directly beneath their respective parent
    const parentChildrenMap: Record<string, AgentSandbox[]> = {};
    subagents.forEach((sub) => {
      const pId = sub.parentId!;
      if (!parentChildrenMap[pId]) parentChildrenMap[pId] = [];
      parentChildrenMap[pId].push(sub);
    });

    Object.entries(parentChildrenMap).forEach(([pId, children]) => {
      const parentPos = positions[pId] || { x: 0, y: 0, level: 0 };
      const totalWidth = children.length * (CARD_W + 30);
      const startX = parentPos.x - totalWidth / 2 + CARD_W / 2;

      children.forEach((child, cIdx) => {
        positions[child.id] = {
          x: startX + cIdx * (CARD_W + 30),
          y: parentPos.y + CARD_H + V_GAP,
          level: 1,
        };
      });
    });

    return positions;
  }, [sandboxes]);

  // Viewport Culling — only render DOM cards that are inside visible bounds
  const visibleSandboxes = useMemo(() => {
    const margin = 300;
    return sandboxes.filter((sb) => {
      const pos = computedLayout[sb.id] || { x: 0, y: 0 };
      const screenX = pos.x * viewport.zoom + viewport.x;
      const screenY = pos.y * viewport.zoom + viewport.y;
      const cardW = CARD_W * viewport.zoom;
      const cardH = CARD_H * viewport.zoom;

      const isInside =
        screenX + cardW >= -margin &&
        screenX <= containerSize.width + margin &&
        screenY + cardH >= -margin &&
        screenY <= containerSize.height + margin;

      // Filter by role/search
      if (filterRole !== 'all') {
        const archetype = sb.archetype || sb.agentClass || 'implementer';
        if (archetype !== filterRole) return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const label = (sb.label || sb.id).toLowerCase();
        if (!label.includes(q)) return false;
      }

      return isInside;
    });
  }, [sandboxes, computedLayout, viewport, containerSize, filterRole, searchQuery]);

  // Canvas Drawing Loop for smooth Bezier connections and traveling particles
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animFrame: number;
    let particleOffset = 0;

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw Grid Pattern
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
      ctx.lineWidth = 1;
      const gridSize = 40 * viewport.zoom;
      const offsetX = viewport.x % gridSize;
      const offsetY = viewport.y % gridSize;

      for (let x = offsetX; x < canvas.width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }
      for (let y = offsetY; y < canvas.height; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }
      ctx.restore();

      // Draw Connection Beziers between Parents and Subagents
      sandboxes.forEach((sb) => {
        if (!sb.parentId) return;
        const parentPos = computedLayout[sb.parentId];
        const childPos = computedLayout[sb.id];
        if (!parentPos || !childPos) return;

        const startX = (parentPos.x + CARD_W / 2) * viewport.zoom + viewport.x;
        const startY = (parentPos.y + CARD_H) * viewport.zoom + viewport.y;
        const endX = (childPos.x + CARD_W / 2) * viewport.zoom + viewport.x;
        const endY = childPos.y * viewport.zoom + viewport.y;

        const cpY1 = startY + (endY - startY) * 0.5;
        const cpY2 = startY + (endY - startY) * 0.5;

        // Draw Bezier Line
        ctx.save();
        ctx.strokeStyle = 'rgba(0, 240, 255, 0.35)';
        ctx.lineWidth = Math.max(1, 2 * viewport.zoom);
        ctx.setLineDash([4 * viewport.zoom, 4 * viewport.zoom]);
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.bezierCurveTo(startX, cpY1, endX, cpY2, endX, endY);
        ctx.stroke();
        ctx.restore();

        // Traveling Pulses
        const t = (particleOffset % 100) / 100;
        const pX =
          Math.pow(1 - t, 3) * startX +
          3 * Math.pow(1 - t, 2) * t * startX +
          3 * (1 - t) * Math.pow(t, 2) * endX +
          Math.pow(t, 3) * endX;
        const pY =
          Math.pow(1 - t, 3) * startY +
          3 * Math.pow(1 - t, 2) * t * cpY1 +
          3 * (1 - t) * Math.pow(t, 2) * cpY2 +
          Math.pow(t, 3) * endY;

        ctx.save();
        ctx.fillStyle = '#00f0ff';
        ctx.shadowColor = '#00f0ff';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(pX, pY, 3 * viewport.zoom, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });

      particleOffset += 0.5;
      animFrame = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animFrame);
  }, [sandboxes, computedLayout, viewport]);

  // Pan Gestures
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - viewport.x, y: e.clientY - viewport.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setViewport((prev) => ({
      ...prev,
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    }));
  };

  const handleMouseUp = () => setIsDragging(false);

  // Zoom Gestures
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    setViewport((prev) => ({
      ...prev,
      zoom: Math.min(1.8, Math.max(0.2, prev.zoom * zoomFactor)),
    }));
  };

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onWheel={handleWheel}
      className={`relative w-full h-[680px] bg-[#09090b] border border-[#232326] rounded-2xl overflow-hidden cursor-grab active:cursor-grabbing select-none ${className}`}
    >
      {/* Background Canvas Layer */}
      <canvas
        ref={canvasRef}
        width={containerSize.width}
        height={containerSize.height}
        className="absolute inset-0 pointer-events-none z-0"
      />

      {/* Control Bar Overlay */}
      <div className="absolute top-3 left-3 z-30 flex items-center gap-2 p-1.5 rounded-xl bg-[#141416]/90 backdrop-blur border border-[#27272a] shadow-xl text-zinc-300 font-mono text-[10px]">
        {/* Search */}
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[#1a1a1d] border border-[#2e2e33]">
          <Search size={12} className="text-zinc-500" />
          <input
            type="text"
            placeholder="Search agents..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="bg-transparent text-zinc-100 placeholder-zinc-500 focus:outline-none w-28 text-[10px]"
            onClick={(e) => e.stopPropagation()}
          />
        </div>

        {/* Filter Dropdown */}
        <div className="flex items-center gap-1">
          <Filter size={11} className="text-zinc-500" />
          <select
            value={filterRole}
            onChange={(e) => setFilterRole(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            className="bg-[#1a1a1d] border border-[#2e2e33] rounded px-1.5 py-1 text-zinc-300 focus:outline-none text-[10px]"
          >
            <option value="all">All Roles</option>
            {AGENT_ROLES.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </div>

        <div className="h-4 w-px bg-[#2e2e33] mx-1" />

        {/* Zoom Controls */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setViewport((v) => ({ ...v, zoom: Math.min(1.8, v.zoom * 1.2) }));
            }}
            className="p-1 rounded hover:bg-[#232326] text-zinc-400 hover:text-zinc-100"
            title="Zoom In"
          >
            <ZoomIn size={12} />
          </button>
          <span className="text-[9px] text-zinc-500 w-8 text-center">
            {Math.round(viewport.zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setViewport((v) => ({ ...v, zoom: Math.max(0.2, v.zoom * 0.8) }));
            }}
            className="p-1 rounded hover:bg-[#232326] text-zinc-400 hover:text-zinc-100"
            title="Zoom Out"
          >
            <ZoomOut size={12} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setViewport({ x: 100, y: 80, zoom: 0.75 });
            }}
            className="p-1 rounded hover:bg-[#232326] text-zinc-400 hover:text-zinc-100"
            title="Reset Canvas View"
          >
            <Maximize size={12} />
          </button>
        </div>
      </div>

      {/* Stats Counter Overlay */}
      <div className="absolute top-3 right-3 z-30 px-3 py-1.5 rounded-xl bg-[#141416]/90 backdrop-blur border border-[#27272a] shadow-xl text-zinc-300 font-mono text-[10px] flex items-center gap-3">
        <span className="flex items-center gap-1.5 text-cyan-400 font-medium">
          <Users size={12} />
          <span>{sandboxes.length} Agents</span>
        </span>
        <span className="text-zinc-500">
          ({visibleSandboxes.length} in viewport)
        </span>
      </div>

      {/* DOM Interactive Sandbox Nodes (Culled) */}
      <div
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          transformOrigin: '0 0',
        }}
        className="absolute inset-0 pointer-events-none z-10"
      >
        {visibleSandboxes.map((sb) => {
          const pos = computedLayout[sb.id] || { x: 0, y: 0 };
          return (
            <div
              key={sb.id}
              style={{
                position: 'absolute',
                left: `${pos.x}px`,
                top: `${pos.y}px`,
                width: `${CARD_W}px`,
              }}
              className="pointer-events-auto"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <UnifiedAgentSandbox
                sandbox={sb}
                fleetReview={fleetReview}
                sessionId={sessionId}
                onUpdate={(patch) => onSandboxUpdate?.(sb.id, patch)}
              />
            </div>
          );
        })}
      </div>

      {/* Minimap Navigation in bottom right */}
      <div className="absolute bottom-3 right-3 z-30 w-44 h-28 bg-[#141416]/90 backdrop-blur border border-[#27272a] rounded-xl p-1.5 shadow-2xl flex flex-col justify-between pointer-events-auto">
        <div className="text-[8px] font-mono text-zinc-500 flex items-center justify-between border-b border-[#232326] pb-1">
          <span>SPATIAL MINIMAP</span>
          <Compass size={10} className="text-cyan-400" />
        </div>
        <div className="flex-1 relative bg-[#09090b] rounded overflow-hidden mt-1">
          {sandboxes.map((sb) => {
            const pos = computedLayout[sb.id] || { x: 0, y: 0 };
            const mX = Math.min(100, Math.max(5, (pos.x / (CARD_W * 6)) * 100));
            const mY = Math.min(100, Math.max(5, (pos.y / (CARD_H * 4)) * 100));
            return (
              <div
                key={sb.id}
                style={{ left: `${mX}%`, top: `${mY}%` }}
                className={`absolute w-1.5 h-1.5 rounded-full -translate-x-1/2 -translate-y-1/2 ${
                  sb.status === 'running'
                    ? 'bg-emerald-400 ring-2 ring-emerald-500/30'
                    : 'bg-cyan-400/80'
                }`}
                title={sb.label || sb.id}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
