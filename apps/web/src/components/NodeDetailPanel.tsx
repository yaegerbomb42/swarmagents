"use client";

/**
 * Node Detail Panel Component
 * Slide-out panel showing detailed task information
 */

import { useState, useEffect } from "react";
import { TaskNode, TaskTree, TaskStatus } from "@/types/decomposition";
import { decompositionApi } from "@/lib/decompositionApi";
import { useNodeUpdates } from "@/hooks/useProjectUpdates";
import {
  X,
  Clock,
  User,
  GitBranch,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Loader2,
  Split,
  RotateCcw,
  Play,
} from "lucide-react";

interface NodeDetailPanelProps {
  projectId: string;
  nodeId: string;
  tree: TaskTree;
  onClose: () => void;
  onRefresh: () => void;
}

export default function NodeDetailPanel({
  projectId,
  nodeId,
  tree,
  onClose,
  onRefresh,
}: NodeDetailPanelProps) {
  const { node, isLoading } = useNodeUpdates(projectId, nodeId);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentNode = node || tree.nodes[nodeId];

  const handleSplit = async () => {
    try {
      setIsProcessing(true);
      setError(null);
      await decompositionApi.splitTaskNode(projectId, nodeId);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to split task");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAssign = async () => {
    try {
      setIsProcessing(true);
      setError(null);
      await decompositionApi.assignTask(projectId, nodeId);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to assign task");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRetry = async () => {
    try {
      setIsProcessing(true);
      setError(null);
      await decompositionApi.retryTask(projectId, nodeId);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to retry task");
    } finally {
      setIsProcessing(false);
    }
  };

  const getStatusIcon = () => {
    switch (currentNode?.status) {
      case TaskStatus.COMPLETED:
        return <CheckCircle2 className="w-5 h-5 text-green-500" />;
      case TaskStatus.FAILED:
        return <XCircle className="w-5 h-5 text-red-500" />;
      case TaskStatus.EXECUTING:
        return <Loader2 className="w-5 h-5 text-purple-500 animate-spin" />;
      case TaskStatus.DECOMPOSING:
        return <Loader2 className="w-5 h-5 text-yellow-500 animate-spin" />;
      default:
        return <Clock className="w-5 h-5 text-gray-400" />;
    }
  };

  const formatDuration = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours}h ${minutes}m ${secs}s`;
  };

  const getChildren = () => {
    if (!currentNode) return [];
    return currentNode.children
      .map((childId) => tree.nodes[childId])
      .filter(Boolean);
  };

  if (!currentNode) {
    return null;
  }

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-2xl bg-white dark:bg-gray-800 shadow-2xl z-50 overflow-y-auto">
        <div className="sticky top-0 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-6 py-4 flex items-center justify-between z-10">
          <div className="flex items-center gap-3">
            {getStatusIcon()}
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              Task Details
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Error Display */}
          {error && (
            <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          {/* Status Badge */}
          <div>
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${
              currentNode.status === TaskStatus.COMPLETED
                ? "bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400"
                : currentNode.status === TaskStatus.FAILED
                ? "bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400"
                : currentNode.status === TaskStatus.EXECUTING
                ? "bg-purple-100 text-purple-800 dark:bg-purple-900/20 dark:text-purple-400"
                : "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300"
            }`}>
              {currentNode.status}
            </span>
          </div>

          {/* Description */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Description
            </h3>
            <p className="text-gray-900 dark:text-white">
              {currentNode.description || "No description provided"}
            </p>
          </div>

          {/* Metadata Grid */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Type</div>
              <div className="text-sm font-medium text-gray-900 dark:text-white capitalize">
                {currentNode.type}
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Depth</div>
              <div className="text-sm font-medium text-gray-900 dark:text-white">
                {currentNode.depth}
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Priority</div>
              <div className="text-sm font-medium text-gray-900 dark:text-white">
                {currentNode.priority} / 10
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Retry Count</div>
              <div className="text-sm font-medium text-gray-900 dark:text-white">
                {currentNode.retry_count} / {currentNode.max_retries}
              </div>
            </div>
          </div>

          {/* Assigned Worker */}
          {currentNode.assigned_worker_id && (
            <div className="flex items-center gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
              <User className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              <div>
                <div className="text-sm font-medium text-gray-900 dark:text-white">
                  Assigned Worker
                </div>
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  {currentNode.assigned_worker_id}
                </div>
              </div>
            </div>
          )}

          {/* Branch */}
          {currentNode.branch_id && (
            <div className="flex items-center gap-2 p-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
              <GitBranch className="w-5 h-5 text-purple-600 dark:text-purple-400" />
              <div>
                <div className="text-sm font-medium text-gray-900 dark:text-white">
                  Branch
                </div>
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  {currentNode.branch_id}
                </div>
              </div>
            </div>
          )}

          {/* Time Budget */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              Time Budget
            </h3>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-gray-600 dark:text-gray-400">Allocated</span>
                <span className="font-medium text-gray-900 dark:text-white">
                  {formatDuration(currentNode.time_budget)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600 dark:text-gray-400">Consumed</span>
                <span className="font-medium text-gray-900 dark:text-white">
                  {formatDuration(currentNode.actual_duration || 0)}
                </span>
              </div>
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                <div
                  className={`h-2 rounded-full transition-all ${
                    (currentNode.actual_duration || 0) > currentNode.time_budget
                      ? "bg-red-500"
                      : "bg-blue-500"
                  }`}
                  style={{
                    width: `${Math.min(
                      100,
                      ((currentNode.actual_duration || 0) / currentNode.time_budget) * 100
                    )}%`,
                  }}
                />
              </div>
            </div>
          </div>

          {/* Requirements */}
          {currentNode.requirements.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Requirements
              </h3>
              <ul className="space-y-1">
                {currentNode.requirements.map((req, idx) => (
                  <li key={idx} className="text-sm text-gray-600 dark:text-gray-400 flex items-start gap-2">
                    <span className="text-blue-500 mt-1">•</span>
                    <span>{req}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Acceptance Criteria */}
          {currentNode.acceptance_criteria.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Acceptance Criteria
              </h3>
              <ul className="space-y-1">
                {currentNode.acceptance_criteria.map((criteria, idx) => (
                  <li key={idx} className="text-sm text-gray-600 dark:text-gray-400 flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
                    <span>{criteria}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Quality Score */}
          {currentNode.quality_score !== null && (
            <div>
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Quality Score
              </h3>
              <div className="flex items-center gap-3">
                <div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                  <div
                    className="bg-green-500 h-2 rounded-full"
                    style={{ width: `${currentNode.quality_score * 100}%` }}
                  />
                </div>
                <span className="text-sm font-medium text-gray-900 dark:text-white">
                  {(currentNode.quality_score * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          )}

          {/* Last Error */}
          {currentNode.last_error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-red-900 dark:text-red-400 mb-1">
                    Error
                  </div>
                  <div className="text-sm text-red-700 dark:text-red-300">
                    {currentNode.last_error}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Children */}
          {getChildren().length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Child Tasks ({getChildren().length})
              </h3>
              <div className="space-y-2">
                {getChildren().map((child) => (
                  <div
                    key={child.id}
                    className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-gray-900 dark:text-white">
                        {child.description.substring(0, 50)}...
                      </span>
                      <span className={`text-xs px-2 py-1 rounded-full ${
                        child.status === TaskStatus.COMPLETED
                          ? "bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400"
                          : "bg-gray-200 text-gray-700 dark:bg-gray-600 dark:text-gray-300"
                      }`}>
                        {child.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3 pt-4 border-t border-gray-200 dark:border-gray-700">
            {currentNode.type === "composite" && currentNode.status === "pending" && (
              <button
                onClick={handleSplit}
                disabled={isProcessing}
                className="flex-1 inline-flex items-center justify-center px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white rounded-lg transition-colors"
              >
                {isProcessing ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Split className="w-4 h-4 mr-2" />
                )}
                Split Task
              </button>
            )}

            {currentNode.type === "leaf" && currentNode.status === "ready" && (
              <button
                onClick={handleAssign}
                disabled={isProcessing}
                className="flex-1 inline-flex items-center justify-center px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white rounded-lg transition-colors"
              >
                {isProcessing ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Play className="w-4 h-4 mr-2" />
                )}
                Assign Worker
              </button>
            )}

            {currentNode.status === "failed" && currentNode.retry_count < currentNode.max_retries && (
              <button
                onClick={handleRetry}
                disabled={isProcessing}
                className="flex-1 inline-flex items-center justify-center px-4 py-2 bg-orange-600 hover:bg-orange-700 disabled:bg-gray-400 text-white rounded-lg transition-colors"
              >
                {isProcessing ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <RotateCcw className="w-4 h-4 mr-2" />
                )}
                Retry Task
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// Made with Bob
