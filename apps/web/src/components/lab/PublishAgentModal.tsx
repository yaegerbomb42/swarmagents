'use client';

import React, { useState } from 'react';
import { useLabStore } from '@/lib/lab/useLabStore';
import { Globe, X, CheckCircle2, ShieldCheck, Sparkles, Tag } from 'lucide-react';

interface PublishModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function PublishAgentModal({ isOpen, onClose }: PublishModalProps) {
  const { activeBlueprint, publishBlueprint } = useLabStore();
  const [releaseNotes, setReleaseNotes] = useState('Initial public release with verified tool integrations.');
  const [tagInput, setTagInput] = useState(activeBlueprint.domainTags.join(', '));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  if (!isOpen) return null;

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    const tags = tagInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    try {
      // POST to backend marketplace API
      await fetch('/api/lab/marketplace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...activeBlueprint,
          domainTags: tags,
          isPublic: true,
        }),
      });

      publishBlueprint(tags, releaseNotes);
      setSuccess(true);
      setTimeout(() => {
        setSuccess(false);
        onClose();
      }, 1200);
    } catch {
      publishBlueprint(tags, releaseNotes);
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fadeIn">
      <div
        className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#070914] shadow-2xl overflow-hidden flex flex-col"
        style={{
          boxShadow: '0 0 40px rgba(16, 185, 129, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
              <Globe className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white tracking-tight">
                Publish Agent to Global Marketplace
              </h2>
              <p className="text-xs text-zinc-400">
                Share this agent blueprint with the worldwide Swarm community.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content Form */}
        <form onSubmit={handlePublish} className="p-6 space-y-4">
          {success ? (
            <div className="p-4 rounded-xl bg-emerald-950/60 border border-emerald-500/40 text-emerald-300 text-center space-y-2">
              <CheckCircle2 className="h-8 w-8 mx-auto text-emerald-400" />
              <h3 className="text-sm font-bold text-white">Agent Successfully Published!</h3>
              <p className="text-xs text-emerald-200">
                Blueprint is now live in the global library feed.
              </p>
            </div>
          ) : (
            <>
              <div className="p-4 rounded-xl border border-white/10 bg-black/40 flex items-center gap-3">
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-lg border"
                  style={{
                    borderColor: `${activeBlueprint.avatar.color}80`,
                    backgroundColor: `${activeBlueprint.avatar.color}15`,
                  }}
                >
                  <Sparkles className="h-5 w-5" style={{ color: activeBlueprint.avatar.color }} />
                </div>
                <div className="min-w-0">
                  <h4 className="text-sm font-bold text-white truncate">{activeBlueprint.name}</h4>
                  <p className="text-xs text-zinc-400 truncate">{activeBlueprint.role}</p>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  Marketplace Discovery Tags (comma separated)
                </label>
                <input
                  type="text"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  placeholder="Rust, Concurrency, Zero-Copy, Invariants..."
                  className="w-full px-3.5 py-2.5 rounded-lg bg-black/60 border border-white/10 text-white text-xs font-mono focus:outline-none focus:border-emerald-400 transition"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  Release Version Notes
                </label>
                <textarea
                  rows={3}
                  value={releaseNotes}
                  onChange={(e) => setReleaseNotes(e.target.value)}
                  placeholder="Describe recent improvements or tool capability updates..."
                  className="w-full px-3.5 py-2.5 rounded-lg bg-black/60 border border-white/10 text-white text-xs focus:outline-none focus:border-emerald-400 transition"
                />
              </div>

              <div className="p-3 rounded-lg border border-white/5 bg-white/[0.02] flex items-center gap-2 text-xs text-zinc-400">
                <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" />
                <span>
                  Manifest complies with SwarmAgents Open Agent Standard v1.0.0.
                </span>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded-lg border border-white/10 text-zinc-400 hover:text-white text-xs font-medium transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-600 text-black font-semibold text-xs disabled:opacity-40 hover:brightness-110 transition shadow-[0_0_16px_rgba(16,185,129,0.3)]"
                >
                  {isSubmitting ? 'Publishing...' : 'Publish to Global Feed'}
                </button>
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
