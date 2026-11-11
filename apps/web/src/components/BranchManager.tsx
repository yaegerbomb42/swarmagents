"use client";

/**
 * Branch Manager Component
 * Manages branches, merging, and conflict resolution
 */

import { useState, useEffect } from "react";
import { Branch, BranchStatus, TaskTree } from "@/types/decomposition";
import { decompositionApi } from "@/lib/decompositionApi";
import {
  GitBranch,
  GitMerge,
  Plus,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
} from "lucide-react";

interface BranchManagerProps {
  projectId: string;
  tree: TaskTree | null;
}

export default function BranchManager({ projectId, tree }: BranchManagerProps) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isMerging, setIsMerging] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create form state
  const [newBranchDescription, setNewBranchDescription] = useState("");
  const [selectedParentNode, setSelectedParentNode] = useState("");

  useEffect(() => {
    loadBranches();
  }, [projectId]);

  const loadBranches = async () => {
    try {
      setIsLoading(true);
      const branchList = await decompositionApi.listBranches(projectId);
      setBranches(branchList);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load branches");
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateBranch = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!newBranchDescription.trim() || !selectedParentNode) {
      setError("Please provide a description and select a parent node");
      return;
    }

    try {
      setIsLoading(true);
      await decompositionApi.createBranch(
        projectId,
        newBranchDescription.trim(),
        selectedParentNode
      );
      setNewBranchDescription("");
      setSelectedParentNode("");
      setShowCreateForm(false);
      await loadBranches();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create branch");
    } finally {
      setIsLoading(false);
    }
  };

  const handleMergeBranch = async (branchId: string) => {
    if (!confirm("Are you sure you want to merge this branch? This cannot be undone.")) {
      return;
    }

    try {
      setIsMerging(branchId);
      setError(null);
      const result = await decompositionApi.mergeBranch(projectId, branchId);
      
      if (result.conflicts.length > 0) {
        setError(`Merge completed with ${result.conflicts.length} conflicts. Manual resolution required.`);
      }
      
      await loadBranches();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to merge branch");
    } finally {
      setIsMerging(null);
    }
  };

  const getStatusIcon = (status: BranchStatus) => {
    switch (status) {
      case BranchStatus.ACTIVE:
        return <Clock className="w-5 h-5 text-blue-500" />;
      case BranchStatus.COMPLETED:
        return <CheckCircle2 className="w-5 h-5 text-green-500" />;
      case BranchStatus.FAILED:
        return <XCircle className="w-5 h-5 text-red-500" />;
      case BranchStatus.MERGED:
        return <GitMerge className="w-5 h-5 text-purple-500" />;
    }
  };

  const getStatusColor = (status: BranchStatus) => {
    switch (status) {
      case BranchStatus.ACTIVE:
        return "bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400";
      case BranchStatus.COMPLETED:
        return "bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400";
      case BranchStatus.FAILED:
        return "bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400";
      case BranchStatus.MERGED:
        return "bg-purple-100 text-purple-800 dark:bg-purple-900/20 dark:text-purple-400";
    }
  };

  const getNodeProgress = (branch: Branch) => {
    if (!tree) return { completed: 0, total: 0, percent: 0 };
    
    const branchNodes = Array.from(branch.node_ids)
      .map(id => tree.nodes[id])
      .filter(Boolean);
    
    const completed = branchNodes.filter(n => n.status === "completed").length;
    const total = branchNodes.length;
    const percent = total > 0 ? (completed / total) * 100 : 0;
    
    return { completed, total, percent };
  };

  const getLeafNodes = () => {
    if (!tree) return [];
    return Object.values(tree.nodes).filter(n => n.type === "leaf");
  };

  if (isLoading && branches.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Error Display */}
      {error && (
        <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      {/* Create Branch Button */}
      <div>
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="inline-flex items-center px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4 mr-2" />
          Create Branch
        </button>
      </div>

      {/* Create Branch Form */}
      {showCreateForm && (
        <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-900 dark:text-white mb-4">
            Create New Branch
          </h3>
          <form onSubmit={handleCreateBranch} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Description
              </label>
              <input
                type="text"
                value={newBranchDescription}
                onChange={(e) => setNewBranchDescription(e.target.value)}
                placeholder="Describe the purpose of this branch"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-800 dark:text-white"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Parent Node
              </label>
              <select
                value={selectedParentNode}
                onChange={(e) => setSelectedParentNode(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-800 dark:text-white"
                required
              >
                <option value="">Select a parent node</option>
                {getLeafNodes().map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.description.substring(0, 60)}
                    {node.description.length > 60 && "..."}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={isLoading}
                className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white rounded-lg transition-colors"
              >
                {isLoading ? "Creating..." : "Create"}
              </button>
              <button
                type="button"
                onClick={() => setShowCreateForm(false)}
                className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Branches List */}
      {branches.length === 0 ? (
        <div className="text-center py-12">
          <GitBranch className="w-12 h-12 mx-auto text-gray-400 mb-4" />
          <p className="text-gray-600 dark:text-gray-400">No branches yet</p>
          <p className="text-sm text-gray-500 dark:text-gray-500 mt-1">
            Create a branch to work on independent task subtrees
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {branches.map((branch) => {
            const progress = getNodeProgress(branch);
            const canMerge = branch.status === BranchStatus.COMPLETED;

            return (
              <div
                key={branch.id}
                className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-start gap-3 flex-1">
                    {getStatusIcon(branch.status)}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-medium text-gray-900 dark:text-white">
                          Branch {branch.id.substring(0, 8)}
                        </h3>
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(branch.status)}`}>
                          {branch.status}
                        </span>
                      </div>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {progress.completed} / {progress.total} nodes completed
                      </p>
                    </div>
                  </div>

                  {canMerge && (
                    <button
                      onClick={() => handleMergeBranch(branch.id)}
                      disabled={isMerging === branch.id}
                      className="inline-flex items-center px-3 py-1.5 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 text-white text-sm rounded-lg transition-colors"
                    >
                      {isMerging === branch.id ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Merging...
                        </>
                      ) : (
                        <>
                          <GitMerge className="w-4 h-4 mr-2" />
                          Merge
                        </>
                      )}
                    </button>
                  )}
                </div>

                {/* Progress Bar */}
                <div className="mb-3">
                  <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                    <div
                      className="bg-blue-500 h-2 rounded-full transition-all"
                      style={{ width: `${progress.percent}%` }}
                    />
                  </div>
                </div>

                {/* Metadata */}
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Parent Node:</span>
                    <p className="font-mono text-xs text-gray-900 dark:text-white mt-1">
                      {branch.parent_node_id.substring(0, 12)}...
                    </p>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Root Node:</span>
                    <p className="font-mono text-xs text-gray-900 dark:text-white mt-1">
                      {branch.root_node_id.substring(0, 12)}...
                    </p>
                  </div>
                </div>

                {/* Merge Conflicts */}
                {branch.merge_conflicts.length > 0 && (
                  <div className="mt-3 p-3 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-orange-500 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium text-orange-900 dark:text-orange-400">
                          {branch.merge_conflicts.length} Merge Conflicts
                        </p>
                        <ul className="mt-1 space-y-1">
                          {branch.merge_conflicts.slice(0, 3).map((conflict, idx) => (
                            <li key={idx} className="text-xs text-orange-700 dark:text-orange-300">
                              • {conflict}
                            </li>
                          ))}
                          {branch.merge_conflicts.length > 3 && (
                            <li className="text-xs text-orange-700 dark:text-orange-300">
                              • And {branch.merge_conflicts.length - 3} more...
                            </li>
                          )}
                        </ul>
                      </div>
                    </div>
                  </div>
                )}

                {/* Merged Into */}
                {branch.merged_into && (
                  <div className="mt-3 p-2 bg-purple-50 dark:bg-purple-900/20 rounded">
                    <p className="text-xs text-purple-700 dark:text-purple-300">
                      Merged into: <span className="font-mono">{branch.merged_into.substring(0, 12)}...</span>
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Summary Stats */}
      {branches.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t border-gray-200 dark:border-gray-700">
          <div className="text-center">
            <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">
              {branches.filter(b => b.status === BranchStatus.ACTIVE).length}
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400">Active</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-green-600 dark:text-green-400">
              {branches.filter(b => b.status === BranchStatus.COMPLETED).length}
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400">Completed</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-purple-600 dark:text-purple-400">
              {branches.filter(b => b.status === BranchStatus.MERGED).length}
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400">Merged</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-red-600 dark:text-red-400">
              {branches.filter(b => b.status === BranchStatus.FAILED).length}
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400">Failed</p>
          </div>
        </div>
      )}
    </div>
  );
}

// Made with Bob
