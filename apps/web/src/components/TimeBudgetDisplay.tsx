"use client";

/**
 * Time Budget Display Component
 * Visual progress bar and breakdown for time budget
 */

import { useState } from "react";
import { TimeBudget, TaskTree } from "@/types/decomposition";
import { decompositionApi } from "@/lib/decompositionApi";
import {
  Clock,
  AlertTriangle,
  TrendingUp,
  Loader2,
  RefreshCw,
} from "lucide-react";

interface TimeBudgetDisplayProps {
  budget: TimeBudget | null;
  tree?: TaskTree | null;
  compact?: boolean;
}

export default function TimeBudgetDisplay({
  budget,
  tree,
  compact = false,
}: TimeBudgetDisplayProps) {
  const [isReallocating, setIsReallocating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!budget) {
    return (
      <div className="text-center py-8">
        <Clock className="w-8 h-8 mx-auto text-gray-400 mb-2" />
        <p className="text-sm text-gray-600 dark:text-gray-400">No budget data available</p>
      </div>
    );
  }

  const handleReallocate = async (strategy: "proportional" | "priority" | "equal") => {
    const projectId = tree?.project_id;
    if (!projectId) return;

    try {
      setIsReallocating(true);
      setError(null);
      await decompositionApi.reallocateBudget(projectId, strategy);
      // Parent component should refresh
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reallocate budget");
    } finally {
      setIsReallocating(false);
    }
  };

  const formatDuration = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  };

  const consumptionRatio = budget.total_seconds > 0
    ? (budget.total_consumed / budget.total_seconds) * 100
    : 0;

  const getProgressColor = () => {
    if (budget.is_exceeded) return "bg-red-500";
    if (budget.is_critical) return "bg-orange-500";
    if (budget.is_warning) return "bg-yellow-500";
    return "bg-blue-500";
  };

  const getStatusIcon = () => {
    if (budget.is_exceeded) {
      return <AlertTriangle className="w-5 h-5 text-red-500" />;
    }
    if (budget.is_critical) {
      return <AlertTriangle className="w-5 h-5 text-orange-500" />;
    }
    if (budget.is_warning) {
      return <AlertTriangle className="w-5 h-5 text-yellow-500" />;
    }
    return <Clock className="w-5 h-5 text-blue-500" />;
  };

  // Compact view for dashboard
  if (compact) {
    return (
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {getStatusIcon()}
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Time Budget
            </h3>
          </div>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {consumptionRatio.toFixed(0)}%
          </span>
        </div>

        <div className="space-y-2">
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3">
            <div
              className={`h-3 rounded-full transition-all ${getProgressColor()}`}
              style={{ width: `${Math.min(100, consumptionRatio)}%` }}
            />
          </div>

          <div className="flex justify-between text-xs text-gray-600 dark:text-gray-400">
            <span>{formatDuration(budget.total_consumed)}</span>
            <span>{formatDuration(budget.total_seconds)}</span>
          </div>
        </div>

        {budget.is_warning && (
          <div className="mt-2 text-xs text-orange-600 dark:text-orange-400">
            ⚠️ {budget.is_exceeded ? "Budget exceeded!" : "Low budget remaining"}
          </div>
        )}
      </div>
    );
  }

  // Full view for detail page
  const topConsumers = tree
    ? Object.entries(budget.node_consumed)
        .map(([nodeId, consumed]) => ({
          nodeId,
          consumed,
          allocated: budget.node_allocations[nodeId] || 0,
          node: tree.nodes[nodeId],
        }))
        .filter((item) => item.node)
        .sort((a, b) => b.consumed - a.consumed)
        .slice(0, 10)
    : [];

  return (
    <div className="space-y-6">
      {/* Error Display */}
      {error && (
        <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      {/* Overall Progress */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            {getStatusIcon()}
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Time Budget Overview
            </h3>
          </div>
          <span className="text-2xl font-bold text-gray-900 dark:text-white">
            {consumptionRatio.toFixed(1)}%
          </span>
        </div>

        <div className="space-y-3">
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-4">
            <div
              className={`h-4 rounded-full transition-all ${getProgressColor()}`}
              style={{ width: `${Math.min(100, consumptionRatio)}%` }}
            />
          </div>

          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-gray-600 dark:text-gray-400 mb-1">Total Budget</p>
              <p className="font-semibold text-gray-900 dark:text-white">
                {formatDuration(budget.total_seconds)}
              </p>
            </div>
            <div>
              <p className="text-gray-600 dark:text-gray-400 mb-1">Consumed</p>
              <p className="font-semibold text-gray-900 dark:text-white">
                {formatDuration(budget.total_consumed)}
              </p>
            </div>
            <div>
              <p className="text-gray-600 dark:text-gray-400 mb-1">Remaining</p>
              <p className="font-semibold text-gray-900 dark:text-white">
                {formatDuration(budget.total_remaining)}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Status Alerts */}
      {budget.is_exceeded && (
        <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            <div>
              <h4 className="font-medium text-red-900 dark:text-red-400 mb-1">
                Budget Exceeded
              </h4>
              <p className="text-sm text-red-700 dark:text-red-300">
                The project has exceeded its allocated time budget. Consider reallocating or
                extending the budget.
              </p>
            </div>
          </div>
        </div>
      )}

      {budget.is_critical && !budget.is_exceeded && (
        <div className="p-4 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-orange-500 flex-shrink-0 mt-0.5" />
            <div>
              <h4 className="font-medium text-orange-900 dark:text-orange-400 mb-1">
                Critical Budget Level
              </h4>
              <p className="text-sm text-orange-700 dark:text-orange-300">
                Less than {((1 - budget.critical_threshold) * 100).toFixed(0)}% of budget
                remaining. Project may not complete within allocated time.
              </p>
            </div>
          </div>
        </div>
      )}

      {budget.is_warning && !budget.is_critical && (
        <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
            <div>
              <h4 className="font-medium text-yellow-900 dark:text-yellow-400 mb-1">
                Low Budget Warning
              </h4>
              <p className="text-sm text-yellow-700 dark:text-yellow-300">
                Less than {((1 - budget.warning_threshold) * 100).toFixed(0)}% of budget
                remaining. Monitor progress closely.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Top Consumers */}
      {topConsumers.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
            Top Time Consumers
          </h4>
          <div className="space-y-2">
            {topConsumers.map((item) => (
              <div
                key={item.nodeId}
                className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg"
              >
                <div className="flex items-start justify-between mb-2">
                  <p className="text-sm font-medium text-gray-900 dark:text-white flex-1 mr-4">
                    {item.node.description.substring(0, 60)}
                    {item.node.description.length > 60 && "..."}
                  </p>
                  <span className="text-sm font-semibold text-gray-900 dark:text-white whitespace-nowrap">
                    {formatDuration(item.consumed)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 bg-gray-200 dark:bg-gray-600 rounded-full h-1.5">
                    <div
                      className={`h-1.5 rounded-full ${
                        item.consumed > item.allocated ? "bg-red-500" : "bg-blue-500"
                      }`}
                      style={{
                        width: `${Math.min(
                          100,
                          (item.consumed / item.allocated) * 100
                        )}%`,
                      }}
                    />
                  </div>
                  <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    / {formatDuration(item.allocated)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reallocation Actions */}
      <div>
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
          Budget Reallocation
        </h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <button
            onClick={() => handleReallocate("proportional")}
            disabled={isReallocating}
            className="flex items-center justify-center gap-2 px-4 py-3 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/30 text-blue-700 dark:text-blue-400 rounded-lg transition-colors disabled:opacity-50"
          >
            {isReallocating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <TrendingUp className="w-4 h-4" />
            )}
            <span className="text-sm font-medium">Proportional</span>
          </button>

          <button
            onClick={() => handleReallocate("priority")}
            disabled={isReallocating}
            className="flex items-center justify-center gap-2 px-4 py-3 bg-purple-50 dark:bg-purple-900/20 hover:bg-purple-100 dark:hover:bg-purple-900/30 text-purple-700 dark:text-purple-400 rounded-lg transition-colors disabled:opacity-50"
          >
            {isReallocating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            <span className="text-sm font-medium">By Priority</span>
          </button>

          <button
            onClick={() => handleReallocate("equal")}
            disabled={isReallocating}
            className="flex items-center justify-center gap-2 px-4 py-3 bg-green-50 dark:bg-green-900/20 hover:bg-green-100 dark:hover:bg-green-900/30 text-green-700 dark:text-green-400 rounded-lg transition-colors disabled:opacity-50"
          >
            {isReallocating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            <span className="text-sm font-medium">Equal Split</span>
          </button>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
          Reallocate remaining budget across pending tasks using different strategies
        </p>
      </div>
    </div>
  );
}

// Made with Bob
