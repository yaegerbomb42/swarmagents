"use client";

import React from "react";
import { motion } from "framer-motion";
import { TaskNode, TaskStatus, TaskType } from "@/types/decomposition";
import { Download, Circle, CheckCircle2, XCircle, Clock, Loader2 } from "lucide-react";

interface TreeNodeProps {
  node: TaskNode;
  x: number;
  y: number;
  scale: number;
  onClick?: () => void;
  onDownload?: () => void;
}

export default function TreeNodeComponent({ node, x, y, scale, onClick, onDownload }: TreeNodeProps) {
  const getNodeClass = () => {
    switch (node.status) {
      case TaskStatus.DECOMPOSING:
        return "neon-node-processing";
      case TaskStatus.READY:
      case TaskStatus.PENDING:
        return "neon-node-ready";
      case TaskStatus.ASSIGNED:
      case TaskStatus.EXECUTING:
      case TaskStatus.VALIDATING:
        return "neon-node-in-progress";
      case TaskStatus.COMPLETED:
        return "neon-node-completed";
      case TaskStatus.FAILED:
      case TaskStatus.BLOCKED:
        return "neon-node-failed";
      default:
        return "neon-node-ready";
    }
  };

  const getNodeIcon = () => {
    const iconSize = Math.max(16, 24 * scale);
    
    // Deliverable nodes (leaf nodes with completed status)
    if (node.type === TaskType.LEAF && node.status === TaskStatus.COMPLETED) {
      return (
        <Download 
          size={iconSize} 
          className="neon-deliverable-icon cursor-pointer" 
          onClick={(e) => {
            e.stopPropagation();
            onDownload?.();
          }}
        />
      );
    }

    switch (node.status) {
      case TaskStatus.DECOMPOSING:
        return <Loader2 size={iconSize} className="animate-spin" />;
      case TaskStatus.READY:
      case TaskStatus.PENDING:
        return <Circle size={iconSize} />;
      case TaskStatus.ASSIGNED:
      case TaskStatus.EXECUTING:
      case TaskStatus.VALIDATING:
        return <Clock size={iconSize} />;
      case TaskStatus.COMPLETED:
        return <CheckCircle2 size={iconSize} />;
      case TaskStatus.FAILED:
      case TaskStatus.BLOCKED:
        return <XCircle size={iconSize} />;
      default:
        return <Circle size={iconSize} />;
    }
  };

  const nodeSize = Math.max(30, 50 * scale);
  const fontSize = Math.max(10, 12 * scale);

  return (
    <motion.g
      initial={{ opacity: 0, scale: 0 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5, type: "spring" }}
      style={{ cursor: "pointer" }}
    >
      {/* Node circle background */}
      <motion.circle
        cx={x}
        cy={y}
        r={nodeSize}
        fill="rgba(0, 0, 0, 0.8)"
        stroke="currentColor"
        strokeWidth={2}
        className={`neon-node ${getNodeClass()}`}
        onClick={onClick}
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.95 }}
      />

      {/* Node icon */}
      <foreignObject
        x={x - nodeSize / 2}
        y={y - nodeSize / 2}
        width={nodeSize}
        height={nodeSize}
        className={`neon-node ${getNodeClass()}`}
        style={{ pointerEvents: node.type === TaskType.LEAF && node.status === TaskStatus.COMPLETED ? "auto" : "none" }}
      >
        <div className="w-full h-full flex items-center justify-center">
          {getNodeIcon()}
        </div>
      </foreignObject>

      {/* Node label */}
      <text
        x={x}
        y={y + nodeSize + 15}
        textAnchor="middle"
        className="neon-label"
        style={{ fontSize: `${fontSize}px` }}
        fill="currentColor"
      >
        {node.description.length > 20 
          ? `${node.description.substring(0, 20)}...` 
          : node.description}
      </text>

      {/* Progress indicator for in-progress nodes */}
      {(node.status === TaskStatus.EXECUTING || node.status === TaskStatus.VALIDATING) && (
        <motion.circle
          cx={x}
          cy={y}
          r={nodeSize + 5}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeDasharray="10 5"
          className={getNodeClass()}
          animate={{ rotate: 360 }}
          transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
          style={{ transformOrigin: `${x}px ${y}px` }}
        />
      )}

      {/* Depth indicator (small badge) */}
      {node.depth > 0 && (
        <circle
          cx={x + nodeSize - 10}
          cy={y - nodeSize + 10}
          r={8}
          fill="rgba(0, 255, 255, 0.3)"
          stroke="var(--neon-cyan)"
          strokeWidth={1}
        />
      )}
      {node.depth > 0 && (
        <text
          x={x + nodeSize - 10}
          y={y - nodeSize + 14}
          textAnchor="middle"
          style={{ fontSize: "10px", fontWeight: "bold" }}
          fill="var(--neon-cyan)"
        >
          {node.depth}
        </text>
      )}
    </motion.g>
  );
}

// Made with Bob
