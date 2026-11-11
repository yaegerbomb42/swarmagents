"use client";

/**
 * Quantum Router Panel Component
 * Displays real-time quantum router intelligence and decision-making
 */

import { useEffect, useState } from "react";
import { QuantumRouterMetrics, QuantumPulse } from "@/types/decomposition";
import {
  Brain,
  Zap,
  TrendingUp,
  Activity,
  Cpu,
  Sparkles,
  ChevronRight,
  Clock,
} from "lucide-react";

interface QuantumRouterPanelProps {
  projectId: string;
  metrics: QuantumRouterMetrics | null;
  isLoading?: boolean;
}

export default function QuantumRouterPanel({
  projectId,
  metrics,
  isLoading = false,
}: QuantumRouterPanelProps) {
  const [pulseAnimation, setPulseAnimation] = useState(false);

  // Trigger animation when new pulse arrives
  useEffect(() => {
    if (metrics?.current_pulse) {
      setPulseAnimation(true);
      const timer = setTimeout(() => setPulseAnimation(false), 1000);
      return () => clearTimeout(timer);
    }
  }, [metrics?.current_pulse?.timestamp]);

  if (isLoading) {
    return (
      <div className="bg-gradient-to-br from-purple-50 to-blue-50 dark:from-purple-900/20 dark:to-blue-900/20 rounded-lg border-2 border-purple-200 dark:border-purple-800 p-6">
        <div className="flex items-center justify-center py-8">
          <Activity className="w-8 h-8 text-purple-500 animate-pulse" />
          <span className="ml-3 text-purple-600 dark:text-purple-400">
            Initializing Quantum Brain...
          </span>
        </div>
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <div className="text-center text-gray-500 dark:text-gray-400">
          <Brain className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p>Quantum Router not available</p>
        </div>
      </div>
    );
  }

  const currentPulse = metrics.current_pulse;
  const routerState = metrics.router_state;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg bg-gradient-to-br from-purple-500 to-blue-500 ${pulseAnimation ? 'animate-pulse' : ''}`}>
            <Brain className="w-6 h-6 text-white" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Quantum Neural Router
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Multi-Head Architectural Intelligence
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 px-3 py-1 bg-green-100 dark:bg-green-900/20 rounded-full">
          <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
          <span className="text-xs font-medium text-green-700 dark:text-green-400">
            LIVE
          </span>
        </div>
      </div>

      {/* Current Pulse */}
      {currentPulse && (
        <div className="bg-gradient-to-br from-purple-50 to-blue-50 dark:from-purple-900/20 dark:to-blue-900/20 rounded-lg border-2 border-purple-200 dark:border-purple-800 p-6">
          <div className="flex items-center gap-2 mb-4">
            <Zap className="w-5 h-5 text-purple-600 dark:text-purple-400" />
            <h4 className="font-semibold text-gray-900 dark:text-white">
              Current Pulse
            </h4>
            <span className="ml-auto text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {new Date(currentPulse.timestamp).toLocaleTimeString()}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Optimal Action */}
            <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-purple-200 dark:border-purple-700">
              <div className="flex items-center gap-2 mb-2">
                <Cpu className="w-4 h-4 text-purple-500" />
                <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                  IMMEDIATE ACTION
                </span>
              </div>
              <p className="text-sm font-semibold text-gray-900 dark:text-white">
                {currentPulse.optimal_action.replace(/_/g, ' ').toUpperCase()}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                  <div
                    className="bg-gradient-to-r from-purple-500 to-blue-500 h-2 rounded-full transition-all"
                    style={{ width: `${currentPulse.confidence * 100}%` }}
                  />
                </div>
                <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                  {(currentPulse.confidence * 100).toFixed(0)}%
                </span>
              </div>
            </div>

            {/* Trajectory */}
            <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-blue-200 dark:border-blue-700">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="w-4 h-4 text-blue-500" />
                <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                  3-STEP TRAJECTORY
                </span>
              </div>
              <div className="space-y-1">
                {currentPulse.optimal_sequence.map((step, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-xs">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center font-medium">
                      {idx + 1}
                    </span>
                    <ChevronRight className="w-3 h-3 text-gray-400" />
                    <span className="text-gray-700 dark:text-gray-300 truncate">
                      {step.replace(/_/g, ' ')}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Thinking Style */}
            <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-indigo-200 dark:border-indigo-700">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles className="w-4 h-4 text-indigo-500" />
                <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                  THINKING STYLE
                </span>
              </div>
              <p className="text-sm font-semibold text-gray-900 dark:text-white">
                {currentPulse.thinking_style.replace(/_/g, ' ').split(' ').map(w => 
                  w.charAt(0).toUpperCase() + w.slice(1)
                ).join(' ')}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                Cognitive approach optimized for current task context
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Router Statistics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-gray-600 dark:text-gray-400">Total Decisions</span>
            <Activity className="w-4 h-4 text-gray-400" />
          </div>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">
            {routerState.total_actions.toLocaleString()}
          </p>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-gray-600 dark:text-gray-400">Avg Success Rate</span>
            <TrendingUp className="w-4 h-4 text-green-500" />
          </div>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">
            {(Object.values(routerState.action_success_rates).reduce((a, b) => a + b, 0) / 
              Math.max(Object.keys(routerState.action_success_rates).length, 1) * 100).toFixed(1)}%
          </p>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-gray-600 dark:text-gray-400">Weight Variance</span>
            <Cpu className="w-4 h-4 text-purple-500" />
          </div>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">
            {routerState.avg_weight_variance.toFixed(3)}
          </p>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-gray-600 dark:text-gray-400">Neocortex</span>
            <Brain className="w-4 h-4 text-indigo-500" />
          </div>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">
            {routerState.neocortex_enabled ? (
              <span className="text-green-600 dark:text-green-400">ACTIVE</span>
            ) : (
              <span className="text-gray-400">OFF</span>
            )}
          </p>
        </div>
      </div>

      {/* Action Distribution */}
      {Object.keys(metrics.action_distribution).length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
          <h4 className="font-semibold text-gray-900 dark:text-white mb-4">
            Action Distribution
          </h4>
          <div className="space-y-3">
            {Object.entries(metrics.action_distribution)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 5)
              .map(([action, count]) => {
                const percentage = (count / routerState.total_actions) * 100;
                const successRate = routerState.action_success_rates[action] || 0;
                return (
                  <div key={action}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="text-gray-700 dark:text-gray-300 font-medium">
                        {action.replace(/_/g, ' ').toUpperCase()}
                      </span>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {count} calls
                        </span>
                        <span className={`text-xs font-medium ${
                          successRate > 0.7 ? 'text-green-600 dark:text-green-400' :
                          successRate > 0.4 ? 'text-yellow-600 dark:text-yellow-400' :
                          'text-red-600 dark:text-red-400'
                        }`}>
                          {(successRate * 100).toFixed(0)}% success
                        </span>
                      </div>
                    </div>
                    <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                      <div
                        className="bg-gradient-to-r from-purple-500 to-blue-500 h-2 rounded-full transition-all"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* Neocortex Stats */}
      {routerState.neocortex_enabled && routerState.neocortex_stats && (
        <div className="bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-indigo-900/20 dark:to-purple-900/20 rounded-lg border border-indigo-200 dark:border-indigo-800 p-6">
          <div className="flex items-center gap-2 mb-4">
            <Brain className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <h4 className="font-semibold text-gray-900 dark:text-white">
              Quantum Neocortex Memory
            </h4>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">Total Memories</p>
              <p className="text-xl font-bold text-gray-900 dark:text-white">
                {routerState.neocortex_stats.total_memories}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">Avg Confidence</p>
              <p className="text-xl font-bold text-gray-900 dark:text-white">
                {(routerState.neocortex_stats.avg_confidence * 100).toFixed(1)}%
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">Pruned</p>
              <p className="text-xl font-bold text-gray-900 dark:text-white">
                {routerState.neocortex_stats.pruned_count}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Made with Bob