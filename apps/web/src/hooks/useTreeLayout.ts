"use client";

import { useMemo } from "react";
import * as d3 from "d3";
import { TaskNode } from "@/types/decomposition";

export interface TreeLayoutNode {
  id: string;
  node: TaskNode;
  x: number;
  y: number;
  children?: TreeLayoutNode[];
}

export interface TreeLayoutEdge {
  source: { x: number; y: number };
  target: { x: number; y: number };
  status: string;
}

interface UseTreeLayoutOptions {
  width: number;
  height: number;
  nodeSpacing?: number;
  levelSpacing?: number;
}

interface UseTreeLayoutReturn {
  nodes: TreeLayoutNode[];
  edges: TreeLayoutEdge[];
  scale: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

/**
 * Hook to calculate dynamic tree layout with automatic scaling
 * Scales tree to fit viewport regardless of node count (5 or 500 nodes)
 */
export function useTreeLayout(
  taskNodes: Record<string, TaskNode>,
  rootNodeId: string | null,
  { width, height, nodeSpacing = 150, levelSpacing = 120 }: UseTreeLayoutOptions
): UseTreeLayoutReturn {
  return useMemo(() => {
    if (!rootNodeId || !taskNodes[rootNodeId]) {
      return { nodes: [], edges: [], scale: 1, bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 } };
    }

    // Build tree hierarchy from flat node structure
    const buildHierarchy = (nodeId: string): TreeLayoutNode | null => {
      const node = taskNodes[nodeId];
      if (!node) return null;

      const children = node.children
        .map(childId => buildHierarchy(childId))
        .filter((child): child is TreeLayoutNode => child !== null);

      return {
        id: nodeId,
        node,
        x: 0,
        y: 0,
        children: children.length > 0 ? children : undefined,
      };
    };

    const root = buildHierarchy(rootNodeId);
    if (!root) {
      return { nodes: [], edges: [], scale: 1, bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 } };
    }

    // Create D3 hierarchy
    const hierarchy = d3.hierarchy(root);
    
    // Calculate tree layout
    const treeLayout = d3.tree<TreeLayoutNode>()
      .nodeSize([nodeSpacing, levelSpacing])
      .separation((a, b) => {
        // More separation for nodes with many siblings
        const siblingCount = Math.max(
          a.parent?.children?.length || 1,
          b.parent?.children?.length || 1
        );
        return a.parent === b.parent ? 1 + siblingCount * 0.1 : 2;
      });

    const treeData = treeLayout(hierarchy);

    // Extract nodes and calculate bounds
    const layoutNodes: TreeLayoutNode[] = [];
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    treeData.each((d) => {
      const node = d.data;
      node.x = d.x;
      node.y = d.y;
      layoutNodes.push(node);

      minX = Math.min(minX, d.x);
      maxX = Math.max(maxX, d.x);
      minY = Math.min(minY, d.y);
      maxY = Math.max(maxY, d.y);
    });

    // Calculate dynamic scale to fit all nodes in viewport
    const treeWidth = maxX - minX;
    const treeHeight = maxY - minY;
    
    // Leave padding for nodes and labels
    const padding = 100;
    const availableWidth = width - padding * 2;
    const availableHeight = height - padding * 2 - 150; // Extra space for input bar

    const scaleX = treeWidth > 0 ? availableWidth / treeWidth : 1;
    const scaleY = treeHeight > 0 ? availableHeight / treeHeight : 1;
    const scale = Math.min(scaleX, scaleY, 1); // Don't scale up, only down

    // Center the tree
    const centerX = width / 2;
    const centerY = (height - 150) / 2; // Account for input bar
    const treeCenterX = (minX + maxX) / 2;
    const treeCenterY = (minY + maxY) / 2;

    // Apply scale and centering to all nodes
    layoutNodes.forEach(node => {
      node.x = centerX + (node.x - treeCenterX) * scale;
      node.y = centerY + (node.y - treeCenterY) * scale;
    });

    // Build edges
    const edges: TreeLayoutEdge[] = [];
    treeData.links().forEach((link) => {
      const sourceNode = link.source.data;
      const targetNode = link.target.data;
      
      edges.push({
        source: { x: sourceNode.x, y: sourceNode.y },
        target: { x: targetNode.x, y: targetNode.y },
        status: targetNode.node.status,
      });
    });

    return {
      nodes: layoutNodes,
      edges,
      scale,
      bounds: {
        minX: centerX + (minX - treeCenterX) * scale,
        maxX: centerX + (maxX - treeCenterX) * scale,
        minY: centerY + (minY - treeCenterY) * scale,
        maxY: centerY + (maxY - treeCenterY) * scale,
      },
    };
  }, [taskNodes, rootNodeId, width, height, nodeSpacing, levelSpacing]);
}

/**
 * Hook to calculate node statistics for display
 */
export function useTreeStats(taskNodes: Record<string, TaskNode>) {
  return useMemo(() => {
    const nodes = Object.values(taskNodes);
    const total = nodes.length;
    const completed = nodes.filter(n => n.status === "completed").length;
    const failed = nodes.filter(n => n.status === "failed").length;
    const inProgress = nodes.filter(n => 
      n.status === "executing" || n.status === "validating" || n.status === "assigned"
    ).length;
    const pending = nodes.filter(n => 
      n.status === "pending" || n.status === "ready"
    ).length;

    return {
      total,
      completed,
      failed,
      inProgress,
      pending,
      progress: total > 0 ? (completed / total) * 100 : 0,
    };
  }, [taskNodes]);
}

// Made with Bob
