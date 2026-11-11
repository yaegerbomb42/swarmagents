/**
 * WebSocket Hook for Real-time Project Updates
 * Manages WebSocket connection and provides reactive updates
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { WebSocketMessage, TaskNode, TaskTree } from "@/types/decomposition";
import { decompositionApi, normalizeTaskNode, normalizeTaskTree } from "@/lib/decompositionApi";

interface UseProjectUpdatesOptions {
  projectId: string;
  onNodeUpdate?: (nodeId: string, node: TaskNode) => void;
  onTreeUpdate?: (tree: TaskTree) => void;
  onWorkerUpdate?: (workerId: string, data: any) => void;
  onBudgetUpdate?: (data: any) => void;
  onError?: (error: Error) => void;
  autoReconnect?: boolean;
  reconnectInterval?: number;
}

interface UseProjectUpdatesReturn {
  isConnected: boolean;
  lastMessage: WebSocketMessage | null;
  error: Error | null;
  reconnect: () => void;
  disconnect: () => void;
}

export function useProjectUpdates({
  projectId,
  onNodeUpdate,
  onTreeUpdate,
  onWorkerUpdate,
  onBudgetUpdate,
  onError,
  autoReconnect = true,
  reconnectInterval = 3000,
}: UseProjectUpdatesOptions): UseProjectUpdatesReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 10;

  const connect = useCallback(() => {
    if (!projectId) return;

    try {
      const wsUrl = decompositionApi.getWebSocketUrl(projectId);
      // Self-contained mode: no external engine WebSocket configured. Skip the
      // socket entirely and let callers fall back to polling.
      if (!wsUrl) {
        setIsConnected(false);
        return;
      }
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log(`WebSocket connected to project ${projectId}`);
        setIsConnected(true);
        setError(null);
        reconnectAttemptsRef.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          setLastMessage(message);

          // Route message to appropriate handler
          switch (message.type) {
            case "node_update":
              if (onNodeUpdate && message.node_id && message.data) {
                onNodeUpdate(message.node_id, normalizeTaskNode(message.data));
              }
              break;
            case "tree_update":
              if (onTreeUpdate) {
                if (message.data?.nodes) {
                  onTreeUpdate(normalizeTaskTree(message.data));
                } else {
                  void decompositionApi.getTaskTree(projectId).then(onTreeUpdate).catch((err) => {
                    const refreshError = err instanceof Error ? err : new Error("Failed to refresh tree");
                    setError(refreshError);
                    if (onError) onError(refreshError);
                  });
                }
              }
              break;
            case "worker_update":
              if (onWorkerUpdate && message.data) {
                onWorkerUpdate(message.data.worker_id, message.data);
              }
              break;
            case "budget_update":
              if (onBudgetUpdate && message.data) {
                onBudgetUpdate(message.data);
              }
              break;
            case "error":
              const err = new Error(message.data?.message || "WebSocket error");
              setError(err);
              if (onError) onError(err);
              break;
          }
        } catch (err) {
          console.error("Failed to parse WebSocket message:", err);
          const parseError = new Error("Failed to parse WebSocket message");
          setError(parseError);
          if (onError) onError(parseError);
        }
      };

      ws.onerror = (event) => {
        console.error("WebSocket error:", event);
        const wsError = new Error("WebSocket connection error");
        setError(wsError);
        if (onError) onError(wsError);
      };

      ws.onclose = (event) => {
        console.log(`WebSocket disconnected from project ${projectId}`, event.code, event.reason);
        setIsConnected(false);

        // Attempt to reconnect if enabled and not at max attempts
        if (
          autoReconnect &&
          reconnectAttemptsRef.current < maxReconnectAttempts &&
          !event.wasClean
        ) {
          reconnectAttemptsRef.current += 1;
          const delay = reconnectInterval * Math.min(reconnectAttemptsRef.current, 5);
          console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})`);

          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, delay);
        }
      };

      wsRef.current = ws;
    } catch (err) {
      console.error("Failed to create WebSocket connection:", err);
      const connectionError = err instanceof Error ? err : new Error("Failed to connect");
      setError(connectionError);
      if (onError) onError(connectionError);
    }
  }, [
    projectId,
    onNodeUpdate,
    onTreeUpdate,
    onWorkerUpdate,
    onBudgetUpdate,
    onError,
    autoReconnect,
    reconnectInterval,
  ]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close(1000, "Client disconnect");
      wsRef.current = null;
    }

    setIsConnected(false);
  }, []);

  const reconnect = useCallback(() => {
    disconnect();
    reconnectAttemptsRef.current = 0;
    connect();
  }, [connect, disconnect]);

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    if (!projectId) {
      disconnect();
      return;
    }

    connect();

    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  return {
    isConnected,
    lastMessage,
    error,
    reconnect,
    disconnect,
  };
}

// Hook for subscribing to specific node updates
export function useNodeUpdates(projectId: string, nodeId: string) {
  const [node, setNode] = useState<TaskNode | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const handleNodeUpdate = useCallback(
    (updatedNodeId: string, updatedNode: TaskNode) => {
      if (updatedNodeId === nodeId) {
        setNode(updatedNode);
        setIsLoading(false);
      }
    },
    [nodeId]
  );

  const { isConnected } = useProjectUpdates({
    projectId,
    onNodeUpdate: handleNodeUpdate,
    onError: setError,
  });

  // Fetch initial node data
  useEffect(() => {
    let mounted = true;

    const fetchNode = async () => {
      try {
        setIsLoading(true);
        const nodeData = await decompositionApi.getTaskNode(projectId, nodeId);
        if (mounted) {
          setNode(nodeData);
          setIsLoading(false);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err : new Error("Failed to fetch node"));
          setIsLoading(false);
        }
      }
    };

    fetchNode();

    return () => {
      mounted = false;
    };
  }, [projectId, nodeId]);

  return { node, isLoading, error, isConnected };
}

// Hook for subscribing to tree updates
export function useTreeUpdates(projectId: string) {
  const [tree, setTree] = useState<TaskTree | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const handleTreeUpdate = useCallback((updatedTree: TaskTree) => {
    setTree(updatedTree);
    setIsLoading(false);
  }, []);

  const { isConnected } = useProjectUpdates({
    projectId,
    onTreeUpdate: handleTreeUpdate,
    onError: setError,
  });

  // Poll when WebSocket is down or project is still active.
  useEffect(() => {
    const active =
      tree?.status &&
      !["completed", "failed", "cancelled"].includes(tree.status);

    if (isConnected && !active) return;

    const interval = setInterval(async () => {
      try {
        const treeData = await decompositionApi.getTaskTree(projectId);
        setTree(treeData);
        setIsLoading(false);
      } catch {
        // ignore transient polling errors
      }
    }, isConnected ? 8000 : 4000);

    return () => clearInterval(interval);
  }, [projectId, isConnected, tree?.status]);

  // Fetch initial tree data
  useEffect(() => {
    let mounted = true;

    const fetchTree = async () => {
      try {
        setIsLoading(true);
        const treeData = await decompositionApi.getTaskTree(projectId);
        if (mounted) {
          setTree(treeData);
          setIsLoading(false);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err : new Error("Failed to fetch tree"));
          setIsLoading(false);
        }
      }
    };

    fetchTree();

    return () => {
      mounted = false;
    };
  }, [projectId]);

  return { tree, isLoading, error, isConnected };
}

// Made with Bob
