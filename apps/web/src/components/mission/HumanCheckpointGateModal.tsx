'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ShieldAlert,
  CheckCircle2,
  XCircle,
  FileCode,
  Wrench,
  AlertTriangle,
  ChevronRight,
  ExternalLink,
  Sliders,
} from 'lucide-react';

export type CheckpointReviewItem = {
  id: string;
  type: 'code_diff' | 'tool_call' | 'api_mutation' | 'file_write';
  title: string;
  description: string;
  riskLevel: 'low' | 'medium' | 'high';
  targetPath?: string;
  diffSnippet?: string;
  toolArgs?: Record<string, unknown>;
};

export interface HumanCheckpointGateModalProps {
  open: boolean;
  onClose: () => void;
  checkpointTitle?: string;
  items?: CheckpointReviewItem[];
  onApprove: (approvedIds: string[]) => void;
  onReject: (rejectedIds: string[], reason?: string) => void;
}

const DEFAULT_REVIEW_ITEMS: CheckpointReviewItem[] = [
  {
    id: 'rev-file-mut-1',
    type: 'file_write',
    title: 'Atomic file write to production deployment config',
    description: 'Autonomous worker requesting write lease on infra/nginx.conf proxy routing block.',
    riskLevel: 'high',
    targetPath: 'infra/nginx.conf',
    diffSnippet: '+ proxy_pass http://omnexx_cluster_upstream;\n+ proxy_set_header X-Fencing-Token $http_x_fencing_token;',
  },
  {
    id: 'rev-tool-call-2',
    type: 'tool_call',
    title: 'Execute database schema migration migration_004',
    description: 'Sub-agent requested shell execution: python scripts/migrate_tables.py --apply',
    riskLevel: 'medium',
    toolArgs: { script: 'migrate_tables.py', dryRun: false, timeoutSec: 30 },
  },
  {
    id: 'rev-code-diff-3',
    type: 'code_diff',
    title: 'Refactor Leaf Runner verification gates',
    description: 'Update contract validation logic to check output tokens and artifact hashes.',
    riskLevel: 'low',
    targetPath: 'apps/swarmagents/engine/decomposition/leaf_runner.py',
    diffSnippet: '- if not result.ok: return False\n+ if not result.ok or result.exit_code != 0: return False',
  },
];

export default function HumanCheckpointGateModal({
  open,
  onClose,
  checkpointTitle = 'Mission Gate Approval Required',
  items = DEFAULT_REVIEW_ITEMS,
  onApprove,
  onReject,
}: HumanCheckpointGateModalProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>(() => items.map((i) => i.id));
  const [rejectReason, setRejectReason] = useState('');
  const [activeItem, setActiveItem] = useState<CheckpointReviewItem | null>(items[0] || null);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
  };

  const handleApproveAll = () => {
    onApprove(selectedIds);
    onClose();
  };

  const handleRejectSelected = () => {
    onReject(selectedIds, rejectReason);
    onClose();
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-[9990] bg-black/75 backdrop-blur-xs"
          />

          {/* Slide-out Drawer */}
          <motion.div
            initial={{ opacity: 0, x: '100%' }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: '100%' }}
            transition={{ type: 'spring', stiffness: 350, damping: 32 }}
            className="fixed right-0 top-0 bottom-0 z-[9995] w-[95vw] max-w-[840px] bg-[#0c0d14] border-l border-white/10 shadow-2xl flex flex-col font-mono text-zinc-100"
          >
            {/* Header */}
            <div className="p-4 md:p-5 border-b border-white/10 bg-[#0f101a] flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400">
                  <ShieldAlert size={20} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm md:text-base font-semibold text-white tracking-tight">
                      {checkpointTitle}
                    </h2>
                    <span className="px-2 py-0.5 rounded-full text-[10px] uppercase font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                      HITL Gate
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-400 mt-0.5">
                    Human-in-the-loop review required before autonomous execution resumes.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 transition"
              >
                ✕
              </button>
            </div>

            {/* Body: Master-Detail Split */}
            <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[280px_1fr] overflow-hidden">
              {/* Left Column: Items List */}
              <div className="border-r border-white/10 overflow-y-auto p-3 space-y-2 bg-[#0a0a10]">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 px-1 font-semibold flex items-center justify-between">
                  <span>Queued Actions ({items.length})</span>
                  <span>{selectedIds.length} approved</span>
                </div>

                {items.map((item) => {
                  const isSelected = selectedIds.includes(item.id);
                  const isCurrent = activeItem?.id === item.id;
                  return (
                    <div
                      key={item.id}
                      onClick={() => setActiveItem(item)}
                      className={`p-2.5 rounded-xl border transition-all cursor-pointer flex flex-col gap-1.5 ${
                        isCurrent
                          ? 'bg-[#181926] border-cyan-500/40 shadow-xs'
                          : 'bg-white/[0.02] border-white/5 hover:border-white/10'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <label className="flex items-center gap-2 text-xs font-semibold text-zinc-200 cursor-pointer min-w-0">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelect(item.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="rounded border-zinc-700 bg-zinc-900 text-cyan-500 focus:ring-0"
                          />
                          <span className="truncate">{item.title}</span>
                        </label>
                        <span
                          className={`text-[9px] uppercase px-1.5 py-0.2 rounded font-bold ${
                            item.riskLevel === 'high'
                              ? 'bg-rose-500/15 text-rose-400 border border-rose-500/30'
                              : item.riskLevel === 'medium'
                              ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                              : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                          }`}
                        >
                          {item.riskLevel}
                        </span>
                      </div>
                      <p className="text-[10px] text-zinc-500 line-clamp-2 leading-relaxed">
                        {item.description}
                      </p>
                    </div>
                  );
                })}
              </div>

              {/* Right Column: Detailed Inspector */}
              <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-5 flex flex-col gap-4 bg-[#0d0e17]">
                {activeItem ? (
                  <>
                    <div className="space-y-1 pb-3 border-b border-white/10">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] uppercase tracking-wider font-semibold text-cyan-400">
                          {activeItem.type.replace('_', ' ')}
                        </span>
                        <span className="text-zinc-600">·</span>
                        <span className="text-xs text-zinc-400">{activeItem.id}</span>
                      </div>
                      <h3 className="text-sm font-semibold text-white">{activeItem.title}</h3>
                      <p className="text-xs text-zinc-400 leading-relaxed">{activeItem.description}</p>
                    </div>

                    {activeItem.targetPath && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5">
                          <FileCode size={12} className="text-cyan-400" />
                          Target File
                        </div>
                        <code className="text-xs text-zinc-200 bg-black/40 border border-white/10 px-2 py-1 rounded block truncate">
                          {activeItem.targetPath}
                        </code>
                      </div>
                    )}

                    {activeItem.diffSnippet && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5">
                          <Sliders size={12} className="text-emerald-400" />
                          Proposed Unified Diff Patch
                        </div>
                        <pre className="text-xs p-3 rounded-xl bg-black/60 border border-white/10 text-zinc-300 overflow-x-auto font-mono whitespace-pre-wrap leading-relaxed">
                          {activeItem.diffSnippet}
                        </pre>
                      </div>
                    )}

                    {activeItem.toolArgs && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5">
                          <Wrench size={12} className="text-amber-400" />
                          Tool Execution Arguments
                        </div>
                        <pre className="text-xs p-3 rounded-xl bg-black/60 border border-white/10 text-zinc-300 overflow-x-auto font-mono whitespace-pre-wrap">
                          {JSON.stringify(activeItem.toolArgs, null, 2)}
                        </pre>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-xs text-zinc-600">
                    Select an action to inspect details
                  </div>
                )}
              </div>
            </div>

            {/* Footer Actions */}
            <div className="p-4 border-t border-white/10 bg-[#0f101a] flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-2 text-xs text-zinc-400">
                <span>Selected: <strong className="text-white">{selectedIds.length}</strong> of {items.length}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleRejectSelected}
                  className="px-3.5 py-1.5 rounded-lg border border-rose-500/30 text-rose-400 hover:bg-rose-500/10 text-xs font-semibold transition flex items-center gap-1.5"
                >
                  <XCircle size={14} />
                  Reject Selected
                </button>
                <button
                  type="button"
                  onClick={handleApproveAll}
                  disabled={selectedIds.length === 0}
                  className="px-4 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30 text-xs font-semibold transition flex items-center gap-1.5 shadow-sm disabled:opacity-50"
                >
                  <CheckCircle2 size={14} />
                  Approve &amp; Proceed ({selectedIds.length})
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
