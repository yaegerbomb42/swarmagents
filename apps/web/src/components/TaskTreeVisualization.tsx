"use client";

/**
 * Task Tree Visualization Component
 * Interactive tree diagram using React Flow
 */

import { useCallback, useMemo, useEffect } from "react";
import {
  ReactFlow,
  Node,
  Edge,
  Controls,
  MiniMap,
  Background,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useNodesInitialized,
  MarkerType,
  Position,
} from "@xyflow/react";

/**
 * Re-fits the viewport to the tree once React Flow has measured all nodes.
 * React Flow's `fitView` prop only runs at mount (before nodes are populated
 * via effect), so without this the tree renders off-screen.
 */
function FitViewOnLoad({ nodeCount }: { nodeCount: number }) {
  const initialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (initialized && nodeCount > 0) {
      fitView({ padding: 0.2, duration: 300 });
    }
  }, [initialized, nodeCount, fitView]);
  return null;
}
import "@xyflow/react/dist/style.css";
import { TaskTree, TaskNode, TaskStatus, TaskType } from "@/types/decomposition";
import {
  Circle,
  Square,
  Triangle,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  AlertCircle,
} from "lucide-react";

interface TaskTreeVisualizationProps {
  tree: TaskTree;
  onNodeSelect: (nodeId: string) => void;
  selectedNodeId: string | null;
}

// Custom node component
function CustomNode({ data }: { data: any }) {
  const node: TaskNode = data.node;
  
  const getStatusIcon = () => {
    switch (node.status) {
      case TaskStatus.COMPLETED:
        return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case TaskStatus.FAILED:
        return <XCircle className="w-4 h-4 text-red-500" />;
      case TaskStatus.EXECUTING:
        return <Loader2 className="w-4 h-4 text-purple-500 animate-spin" />;
      case TaskStatus.DECOMPOSING:
        return <Loader2 className="w-4 h-4 text-yellow-500 animate-spin" />;
      case TaskStatus.ASSIGNED:
        return <Clock className="w-4 h-4 text-blue-500" />;
      case TaskStatus.BLOCKED:
        return <AlertCircle className="w-4 h-4 text-orange-500" />;
      default:
        return <Circle className="w-4 h-4 text-gray-400" />;
    }
  };

  const getTypeIcon = () => {
    switch (node.type) {
      case TaskType.ROOT:
        return <Triangle className="w-3 h-3" />;
      case TaskType.COMPOSITE:
        return <Square className="w-3 h-3" />;
      case TaskType.LEAF:
        return <Circle className="w-3 h-3" />;
    }
  };

  const getStatusColor = () => {
    switch (node.status) {
      case TaskStatus.COMPLETED:
        return "border-green-500 bg-green-50 dark:bg-green-900/20";
      case TaskStatus.FAILED:
        return "border-red-500 bg-red-50 dark:bg-red-900/20";
      case TaskStatus.EXECUTING:
        return "border-purple-500 bg-purple-50 dark:bg-purple-900/20";
      case TaskStatus.DECOMPOSING:
        return "border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20";
      case TaskStatus.ASSIGNED:
        return "border-blue-500 bg-blue-50 dark:bg-blue-900/20";
      case TaskStatus.BLOCKED:
        return "border-orange-500 bg-orange-50 dark:bg-orange-900/20";
      default:
        return "border-gray-300 bg-white dark:bg-gray-800 dark:border-gray-600";
    }
  };

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 shadow-sm min-w-[200px] max-w-[300px] ${getStatusColor()} ${
        data.selected ? "ring-2 ring-blue-500" : ""
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        {getTypeIcon()}
        <span className="text-xs font-medium text-gray-600 dark:text-gray-400 uppercase">
          {node.type}
        </span>
        {getStatusIcon()}
      </div>
      
      <div className="text-sm font-medium text-gray-900 dark:text-white mb-1 line-clamp-2">
        {node.description || "Untitled Task"}
      </div>
      
      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
        <span>Depth: {node.depth}</span>
        {node.children.length > 0 && (
          <span>{node.children.length} children</span>
        )}
      </div>
      
      {node.time_budget > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
          <div className="flex justify-between text-xs">
            <span className="text-gray-500 dark:text-gray-400">Time</span>
            <span className="font-medium">
              {Math.round((node.actual_duration || 0) / 60)}m / {Math.round(node.time_budget / 60)}m
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

const nodeTypes = {
  custom: CustomNode,
};

export default function TaskTreeVisualization({
  tree,
  onNodeSelect,
  selectedNodeId,
}: TaskTreeVisualizationProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Convert task tree to React Flow nodes and edges
  const { flowNodes, flowEdges } = useMemo(() => {
    const flowNodes: Node[] = [];
    const flowEdges: Edge[] = [];
    const nodeMap = new Map<string, { x: number; y: number; level: number }>();

    // Calculate positions using a tree layout algorithm
    const calculatePositions = (nodeId: string, level: number, xOffset: number): number => {
      const node = tree.nodes[nodeId];
      if (!node) return xOffset;

      const childCount = node.children.length;
      let currentX = xOffset;

      if (childCount === 0) {
        // Leaf node
        nodeMap.set(nodeId, { x: currentX, y: level * 150, level });
        return currentX + 350;
      }

      // Calculate positions for children first
      const childPositions: number[] = [];
      for (const childId of node.children) {
        const childX = calculatePositions(childId, level + 1, currentX);
        childPositions.push(currentX);
        currentX = childX;
      }

      // Position parent at the center of its children
      const firstChildX = childPositions[0];
      const lastChildX = childPositions[childPositions.length - 1];
      const parentX = (firstChildX + lastChildX) / 2;

      nodeMap.set(nodeId, { x: parentX, y: level * 150, level });
      return currentX;
    };

    // Start layout from root
    if (tree.root_node_id) {
      calculatePositions(tree.root_node_id, 0, 0);
    }

    // Create React Flow nodes
    Object.entries(tree.nodes).forEach(([nodeId, node]) => {
      const position = nodeMap.get(nodeId) || { x: 0, y: 0, level: 0 };
      
      flowNodes.push({
        id: nodeId,
        type: "custom",
        position: { x: position.x, y: position.y },
        data: {
          node,
          label: node.description,
          selected: nodeId === selectedNodeId,
        },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
      });

      // Create edges to children
      node.children.forEach((childId) => {
        flowEdges.push({
          id: `${nodeId}-${childId}`,
          source: nodeId,
          target: childId,
          type: "smoothstep",
          animated: node.status === TaskStatus.EXECUTING || node.status === TaskStatus.DECOMPOSING,
          style: {
            stroke: node.status === TaskStatus.COMPLETED ? "#10b981" : "#6b7280",
            strokeWidth: 2,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: node.status === TaskStatus.COMPLETED ? "#10b981" : "#6b7280",
          },
        });
      });
    });

    return { flowNodes, flowEdges };
  }, [tree, selectedNodeId]);

  // Update nodes and edges when tree changes.
  useEffect(() => {
    setNodes(flowNodes);
    setEdges(flowEdges);
  }, [flowNodes, flowEdges, setNodes, setEdges]);

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      onNodeSelect(node.id);
    },
    [onNodeSelect]
  );

  const getNodeColor = (node: Node) => {
    const taskNode = node.data.node as TaskNode;
    switch (taskNode.status) {
      case TaskStatus.COMPLETED:
        return "#10b981";
      case TaskStatus.FAILED:
        return "#ef4444";
      case TaskStatus.EXECUTING:
        return "#8b5cf6";
      case TaskStatus.DECOMPOSING:
        return "#eab308";
      case TaskStatus.ASSIGNED:
        return "#3b82f6";
      default:
        return "#9ca3af";
    }
  };

  if (!tree || Object.keys(tree.nodes).length === 0) {
    return (
      <div className="h-[600px] flex items-center justify-center bg-gray-50 dark:bg-gray-900 rounded-lg">
        <div className="text-center">
          <Circle className="w-12 h-12 text-gray-400 mx-auto mb-4" />
          <p className="text-gray-600 dark:text-gray-400">No task tree available</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[600px] bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.1}
        maxZoom={1.5}
        defaultViewport={{ x: 0, y: 0, zoom: 0.8 }}
      >
        <FitViewOnLoad nodeCount={nodes.length} />
        <Background color="#9ca3af" gap={16} />
        <Controls />
        <MiniMap
          nodeColor={getNodeColor}
          maskColor="rgba(0, 0, 0, 0.2)"
          style={{
            backgroundColor: "rgba(255, 255, 255, 0.9)",
          }}
        />
      </ReactFlow>

      {/* Legend */}
      <div className="absolute bottom-4 left-4 bg-white dark:bg-gray-800 rounded-lg shadow-lg p-4 border border-gray-200 dark:border-gray-700">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Status Legend</h4>
        <div className="space-y-2 text-xs">
          {[
            { status: "Pending", color: "text-gray-500", icon: Circle },
            { status: "Decomposing", color: "text-yellow-500", icon: Loader2 },
            { status: "Assigned", color: "text-blue-500", icon: Clock },
            { status: "Executing", color: "text-purple-500", icon: Loader2 },
            { status: "Completed", color: "text-green-500", icon: CheckCircle2 },
            { status: "Failed", color: "text-red-500", icon: XCircle },
            { status: "Blocked", color: "text-orange-500", icon: AlertCircle },
          ].map(({ status, color, icon: Icon }) => (
            <div key={status} className="flex items-center gap-2">
              <Icon className={`w-4 h-4 ${color}`} />
              <span className="text-gray-700 dark:text-gray-300">{status}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Made with Bob
