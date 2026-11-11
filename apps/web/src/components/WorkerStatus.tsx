"use client";

/**
 * Worker Status Component
 * Displays grid of worker cards with status and metrics
 */

import { useState } from "react";
import { WorkerAgent, WorkerStatus as WorkerStatusEnum } from "@/types/decomposition";
import { decompositionApi } from "@/lib/decompositionApi";
import {
  Cpu,
  Activity,
  CheckCircle2,
  XCircle,
  Clock,
  RotateCcw,
  Loader2,
  TrendingUp,
} from "lucide-react";

interface WorkerStatusProps {
  workers: WorkerAgent[];
  onRefresh: () => void;
}

export default function WorkerStatus({ workers, onRefresh }: WorkerStatusProps) {
  const [restartingWorker, setRestartingWorker] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRestart = async (workerId: string) => {
    try {
      setRestartingWorker(workerId);
      setError(null);
      await decompositionApi.restartWorker(workerId);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to restart worker");
    } finally {
      setRestartingWorker(null);
    }
  };

  const getStatusColor = (status: WorkerStatusEnum) => {
    switch (status) {
      case WorkerStatusEnum.IDLE:
        return "bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400";
      case WorkerStatusEnum.BUSY:
        return "bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400";
      case WorkerStatusEnum.FAILED:
        return "bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400";
      case WorkerStatusEnum.OFFLINE:
        return "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300";
    }
  };

  const getStatusIcon = (status: WorkerStatusEnum) => {
    switch (status) {
      case WorkerStatusEnum.IDLE:
        return <Clock className="w-5 h-5 text-green-500" />;
      case WorkerStatusEnum.BUSY:
        return <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />;
      case WorkerStatusEnum.FAILED:
        return <XCircle className="w-5 h-5 text-red-500" />;
      case WorkerStatusEnum.OFFLINE:
        return <Activity className="w-5 h-5 text-gray-400" />;
    }
  };

  const formatTime = (seconds: number) => {
    if (seconds < 60) return `${seconds.toFixed(0)}s`;
    if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
  };

  if (workers.length === 0) {
    return (
      <div className="text-center py-12">
        <Cpu className="w-12 h-12 mx-auto text-gray-400 mb-4" />
        <p className="text-gray-600 dark:text-gray-400">No workers available</p>
        <p className="text-sm text-gray-500 dark:text-gray-500 mt-1">
          Workers will appear here when the system is running
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Error Display */}
      {error && (
        <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      {/* Worker Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {workers.map((worker) => (
          <div
            key={worker.id}
            className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 hover:shadow-lg transition-shadow"
          >
            {/* Header */}
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                  <Cpu className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <h3 className="font-medium text-gray-900 dark:text-white">
                    {worker.name || worker.id}
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {worker.model_name}
                  </p>
                </div>
              </div>
              {getStatusIcon(worker.status)}
            </div>

            {/* Status Badge */}
            <div className="mb-4">
              <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(worker.status)}`}>
                {worker.status}
              </span>
            </div>

            {/* Current Task */}
            {worker.current_task_id && (
              <div className="mb-4 p-2 bg-blue-50 dark:bg-blue-900/20 rounded">
                <p className="text-xs text-gray-600 dark:text-gray-400 mb-1">Current Task</p>
                <p className="text-sm font-mono text-gray-900 dark:text-white truncate">
                  {worker.current_task_id}
                </p>
              </div>
            )}

            {/* Metrics */}
            <div className="space-y-3 mb-4">
              {/* Tasks Completed */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                  <span>Completed</span>
                </div>
                <span className="text-sm font-medium text-gray-900 dark:text-white">
                  {worker.tasks_completed}
                </span>
              </div>

              {/* Tasks Failed */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                  <XCircle className="w-4 h-4 text-red-500" />
                  <span>Failed</span>
                </div>
                <span className="text-sm font-medium text-gray-900 dark:text-white">
                  {worker.tasks_failed}
                </span>
              </div>

              {/* Success Rate */}
              {(worker.tasks_completed + worker.tasks_failed) > 0 && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                    <TrendingUp className="w-4 h-4 text-blue-500" />
                    <span>Success Rate</span>
                  </div>
                  <span className="text-sm font-medium text-gray-900 dark:text-white">
                    {(
                      (worker.tasks_completed / (worker.tasks_completed + worker.tasks_failed)) *
                      100
                    ).toFixed(0)}%
                  </span>
                </div>
              )}

              {/* Average Quality */}
              {worker.average_quality_score > 0 && (
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-gray-600 dark:text-gray-400">Avg Quality</span>
                    <span className="font-medium text-gray-900 dark:text-white">
                      {(worker.average_quality_score * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
                    <div
                      className="bg-green-500 h-1.5 rounded-full"
                      style={{ width: `${worker.average_quality_score * 100}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Average Execution Time */}
              {worker.average_execution_time > 0 && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                    <Clock className="w-4 h-4 text-purple-500" />
                    <span>Avg Time</span>
                  </div>
                  <span className="text-sm font-medium text-gray-900 dark:text-white">
                    {formatTime(worker.average_execution_time)}
                  </span>
                </div>
              )}
            </div>

            {/* Resource Usage */}
            <div className="pt-3 border-t border-gray-200 dark:border-gray-700 space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-gray-500 dark:text-gray-400">Memory</span>
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {worker.memory_usage_mb.toFixed(0)} MB
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gray-500 dark:text-gray-400">CPU</span>
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {worker.cpu_usage_percent.toFixed(1)}%
                </span>
              </div>
            </div>

            {/* Specialization */}
            {worker.specialization && (
              <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Specialization</p>
                <span className="inline-block px-2 py-1 bg-purple-100 dark:bg-purple-900/20 text-purple-800 dark:text-purple-400 text-xs rounded">
                  {worker.specialization}
                </span>
              </div>
            )}

            {/* Restart Button */}
            {worker.status === WorkerStatusEnum.FAILED && (
              <button
                onClick={() => handleRestart(worker.id)}
                disabled={restartingWorker === worker.id}
                className="w-full mt-4 inline-flex items-center justify-center px-3 py-2 bg-orange-600 hover:bg-orange-700 disabled:bg-gray-400 text-white text-sm rounded-lg transition-colors"
              >
                {restartingWorker === worker.id ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Restarting...
                  </>
                ) : (
                  <>
                    <RotateCcw className="w-4 h-4 mr-2" />
                    Restart Worker
                  </>
                )}
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Summary Stats */}
      <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4">
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">Idle Workers</p>
          <p className="text-2xl font-bold text-green-600 dark:text-green-400">
            {workers.filter((w) => w.status === WorkerStatusEnum.IDLE).length}
          </p>
        </div>
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">Busy Workers</p>
          <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">
            {workers.filter((w) => w.status === WorkerStatusEnum.BUSY).length}
          </p>
        </div>
        <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4">
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">Failed Workers</p>
          <p className="text-2xl font-bold text-red-600 dark:text-red-400">
            {workers.filter((w) => w.status === WorkerStatusEnum.FAILED).length}
          </p>
        </div>
        <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4">
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">Total Tasks</p>
          <p className="text-2xl font-bold text-purple-600 dark:text-purple-400">
            {workers.reduce((sum, w) => sum + w.tasks_completed + w.tasks_failed, 0)}
          </p>
        </div>
      </div>
    </div>
  );
}

// Made with Bob
