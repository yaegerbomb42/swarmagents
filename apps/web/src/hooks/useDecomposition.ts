"use client";

import { useState, useCallback, useEffect } from "react";
import { 
  TaskTree, 
  TaskNode, 
  CreateProjectRequest,
  ProjectResponse,
  DeliverableType 
} from "@/types/decomposition";
import { decompositionApi } from "@/lib/decompositionApi";
import { useProjectUpdates } from "./useProjectUpdates";

interface UseDecompositionReturn {
  // State
  projectId: string | null;
  tree: TaskTree | null;
  isProcessing: boolean;
  isConnected: boolean;
  error: Error | null;
  
  // Actions
  startDecomposition: (description: string, timeBudgetHours: number, deliverableType: DeliverableType) => Promise<void>;
  refreshTree: () => Promise<void>;
  reset: () => void;
  downloadDeliverable: (nodeId: string) => Promise<void>;
}

/**
 * Hook to manage task decomposition lifecycle with WebSocket updates
 */
export function useDecomposition(): UseDecompositionReturn {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [tree, setTree] = useState<TaskTree | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // WebSocket connection for real-time updates
  const { isConnected } = useProjectUpdates({
    projectId: projectId || "",
    onNodeUpdate: useCallback((nodeId: string, node: TaskNode) => {
      setTree(prevTree => {
        if (!prevTree) return null;
        return {
          ...prevTree,
          nodes: {
            ...prevTree.nodes,
            [nodeId]: node,
          },
        };
      });
    }, []),
    onTreeUpdate: useCallback((updatedTree: TaskTree) => {
      setTree(updatedTree);
      
      // Stop processing when tree is completed or failed
      if (updatedTree.status === "completed" || updatedTree.status === "failed") {
        setIsProcessing(false);
      }
    }, []),
    onError: useCallback((err: Error) => {
      console.error("WebSocket error:", err);
      setError(err);
    }, []),
    autoReconnect: true,
  });

  // Start decomposition process
  const startDecomposition = useCallback(async (
    description: string,
    timeBudgetHours: number,
    deliverableType: DeliverableType
  ) => {
    try {
      setIsProcessing(true);
      setError(null);

      const request: CreateProjectRequest = {
        description,
        deliverable_type: deliverableType,
        time_budget_hours: timeBudgetHours,
        metadata: {
          created_from: "neon-ui",
          timestamp: new Date().toISOString(),
        },
      };

      const response: ProjectResponse = await decompositionApi.createProject(request);
      setProjectId(response.project_id);

      // Fetch initial tree
      const initialTree = await decompositionApi.getTaskTree(response.project_id);
      setTree(initialTree);
      setIsProcessing(["decomposing", "executing", "validating"].includes(initialTree.status));

    } catch (err) {
      console.error("Failed to start decomposition:", err);
      setError(err instanceof Error ? err : new Error("Failed to start decomposition"));
      setIsProcessing(false);
    }
  }, []);

  const refreshTree = useCallback(async () => {
    if (!projectId) return;
    const updatedTree = await decompositionApi.getTaskTree(projectId);
    setTree(updatedTree);
    if (["completed", "failed", "cancelled"].includes(updatedTree.status)) {
      setIsProcessing(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !isProcessing) return;
    const interval = setInterval(() => {
      void refreshTree();
    }, 4000);
    return () => clearInterval(interval);
  }, [projectId, isProcessing, refreshTree]);

  // Reset state
  const reset = useCallback(() => {
    setProjectId(null);
    setTree(null);
    setIsProcessing(false);
    setError(null);
  }, []);

  // Download deliverable
  const downloadDeliverable = useCallback(async (nodeId: string) => {
    if (!projectId) return;

    try {
      const blob = await decompositionApi.downloadDeliverable(projectId);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `deliverable-${nodeId}.zip`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      console.error("Failed to download deliverable:", err);
      setError(err instanceof Error ? err : new Error("Failed to download deliverable"));
    }
  }, [projectId]);

  return {
    projectId,
    tree,
    isProcessing,
    isConnected: projectId ? isConnected : false,
    error,
    startDecomposition,
    refreshTree,
    reset,
    downloadDeliverable,
  };
}

/**
 * Hook to manage node selection and details
 */
export function useNodeSelection() {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  const selectNode = useCallback((nodeId: string | null) => {
    setSelectedNodeId(nodeId);
  }, []);

  const hoverNode = useCallback((nodeId: string | null) => {
    setHoveredNodeId(nodeId);
  }, []);

  return {
    selectedNodeId,
    hoveredNodeId,
    selectNode,
    hoverNode,
  };
}

// Made with Bob
