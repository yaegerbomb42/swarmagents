"use client";

import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { TaskTree, TaskStatus } from "@/types/decomposition";
import { useTreeLayout, useTreeStats } from "@/hooks/useTreeLayout";
import { useNodeSelection } from "@/hooks/useDecomposition";
import TreeNodeComponent from "./TreeNode";
import { ZoomIn, ZoomOut, Maximize2, Wifi, WifiOff } from "lucide-react";

interface NeonTreeProps {
  tree: TaskTree | null;
  isConnected: boolean;
  onDownloadDeliverable: (nodeId: string) => void;
}

export default function NeonTree({ tree, isConnected, onDownloadDeliverable }: NeonTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 1200, height: 800 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [tooltipNode, setTooltipNode] = useState<{ id: string; x: number; y: number } | null>(null);

  const { selectedNodeId, hoveredNodeId, selectNode, hoverNode } = useNodeSelection();

  // Update dimensions on resize
  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };

    updateDimensions();
    window.addEventListener("resize", updateDimensions);
    return () => window.removeEventListener("resize", updateDimensions);
  }, []);

  // Calculate tree layout
  const { nodes, edges, scale: autoScale } = useTreeLayout(
    tree?.nodes || {},
    tree?.root_node_id || null,
    dimensions
  );

  // Calculate stats
  const stats = useTreeStats(tree?.nodes || {});

  // Zoom controls
  const handleZoomIn = () => setZoom(prev => Math.min(prev * 1.2, 3));
  const handleZoomOut = () => setZoom(prev => Math.max(prev / 1.2, 0.3));
  const handleResetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // Pan controls
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) {
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning) {
      setPan({
        x: e.clientX - panStart.x,
        y: e.clientY - panStart.y,
      });
    }
  };

  const handleMouseUp = () => {
    setIsPanning(false);
  };

  // Get line class based on status
  const getLineClass = (status: string) => {
    switch (status) {
      case TaskStatus.COMPLETED:
        return "neon-line-completed";
      case TaskStatus.EXECUTING:
      case TaskStatus.VALIDATING:
      case TaskStatus.ASSIGNED:
        return "neon-line-in-progress";
      case TaskStatus.FAILED:
      case TaskStatus.BLOCKED:
        return "neon-line-blocked";
      default:
        return "neon-line-pending";
    }
  };

  // Show tooltip on hover
  const handleNodeHover = (nodeId: string, x: number, y: number) => {
    hoverNode(nodeId);
    setTooltipNode({ id: nodeId, x, y });
  };

  const handleNodeLeave = () => {
    hoverNode(null);
    setTooltipNode(null);
  };

  if (!tree) {
    return (
      <div className="neon-tree-container w-full h-full flex items-center justify-center">
        <div className="text-center">
          <div className="text-2xl font-mono mb-4" style={{ color: "var(--neon-cyan)" }}>
            Ready to decompose your task
          </div>
          <div className="text-sm font-mono opacity-60" style={{ color: "var(--neon-cyan)" }}>
            Enter a task description below to get started
          </div>
        </div>
      </div>
    );
  }

  return (
    <div 
      ref={containerRef}
      className="neon-tree-container w-full h-full relative overflow-hidden"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor: isPanning ? "grabbing" : "grab" }}
    >
      {/* Status indicator */}
      <div className="neon-status flex items-center gap-2">
        {isConnected ? (
          <>
            <Wifi size={16} />
            <span>Connected</span>
          </>
        ) : (
          <>
            <WifiOff size={16} />
            <span>Disconnected</span>
          </>
        )}
      </div>

      {/* Stats display */}
      <div className="absolute top-20 left-5 space-y-2 z-10">
        <div className="neon-status text-xs">
          <div>Total: {stats.total}</div>
          <div style={{ color: "var(--neon-green)" }}>✓ {stats.completed}</div>
          <div style={{ color: "var(--neon-yellow)" }}>⟳ {stats.inProgress}</div>
          <div style={{ color: "var(--neon-blue)" }}>○ {stats.pending}</div>
          <div style={{ color: "var(--neon-red)" }}>✗ {stats.failed}</div>
        </div>
        <div className="neon-progress-bar h-2 w-32">
          <div 
            className="neon-progress-fill h-full"
            style={{ width: `${stats.progress}%` }}
          />
        </div>
      </div>

      {/* Zoom controls */}
      <div className="neon-zoom-controls">
        <button className="neon-zoom-button" onClick={handleZoomIn} title="Zoom In">
          <ZoomIn size={20} />
        </button>
        <button className="neon-zoom-button" onClick={handleZoomOut} title="Zoom Out">
          <ZoomOut size={20} />
        </button>
        <button className="neon-zoom-button" onClick={handleResetView} title="Reset View">
          <Maximize2 size={20} />
        </button>
      </div>

      {/* SVG Canvas */}
      <svg
        width={dimensions.width}
        height={dimensions.height}
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: "center center",
          transition: isPanning ? "none" : "transform 0.3s ease",
        }}
      >
        <defs>
          {/* Glow filters for different states */}
          <filter id="neon-glow-cyan">
            <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
            <feMerge>
              <feMergeNode in="coloredBlur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
        </defs>

        {/* Render edges */}
        <g className="edges">
          <AnimatePresence>
            {edges.map((edge, index) => (
              <motion.path
                key={`edge-${index}`}
                d={`M ${edge.source.x} ${edge.source.y} L ${edge.target.x} ${edge.target.y}`}
                className={`neon-line ${getLineClass(edge.status)}`}
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                exit={{ pathLength: 0, opacity: 0 }}
                transition={{ duration: 0.5 }}
              />
            ))}
          </AnimatePresence>
        </g>

        {/* Render nodes */}
        <g className="nodes">
          {nodes.map((layoutNode) => (
            <g
              key={layoutNode.id}
              onMouseEnter={() => handleNodeHover(layoutNode.id, layoutNode.x, layoutNode.y)}
              onMouseLeave={handleNodeLeave}
            >
              <TreeNodeComponent
                node={layoutNode.node}
                x={layoutNode.x}
                y={layoutNode.y}
                scale={autoScale}
                onClick={() => selectNode(layoutNode.id)}
                onDownload={() => onDownloadDeliverable(layoutNode.id)}
              />
            </g>
          ))}
        </g>
      </svg>

      {/* Tooltip */}
      <AnimatePresence>
        {tooltipNode && tree.nodes[tooltipNode.id] && (
          <motion.div
            className="neon-tooltip"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            style={{
              left: tooltipNode.x * zoom + pan.x + 60,
              top: tooltipNode.y * zoom + pan.y - 20,
            }}
          >
            <div className="font-bold mb-1">{tree.nodes[tooltipNode.id].description}</div>
            <div className="text-xs opacity-80">
              <div>Status: {tree.nodes[tooltipNode.id].status}</div>
              <div>Type: {tree.nodes[tooltipNode.id].type}</div>
              <div>Depth: {tree.nodes[tooltipNode.id].depth}</div>
              {tree.nodes[tooltipNode.id].estimated_duration > 0 && (
                <div>Est. Time: {tree.nodes[tooltipNode.id].estimated_duration}s</div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Made with Bob
