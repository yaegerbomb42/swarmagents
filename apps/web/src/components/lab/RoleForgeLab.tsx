'use client';

import React, { useRef, useState } from 'react';
import type { AgentRoleCard } from '@/lib/lab/roleLibrary';
import AgentRoleCardView from './AgentRoleCard';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { authHeaders } from '@/lib/auth';
import { Send, RefreshCw, Sparkles, Wand2 } from 'lucide-react';

const EXAMPLE_PROMPTS = [
  'Context Condenser — shrinks 500k tokens into an 8k executive briefing',
  'Rust Auditor — Rust async concurrency auditor for Tokio worker pools',
  'SQL Planner — PostgreSQL query planner that reads EXPLAIN ANALYZE output',
];

interface RoleForgeLabProps {
  /** Embedded mode (used by the landing-page demo) */
  embedded?: boolean;
  /** Explicit identity override — wins over the signed-in user (landing demo) */
  ownerId?: string;
  ownerName?: string;
}

export default function RoleForgeLab({ ownerId, ownerName }: RoleForgeLabProps) {
  const currentUser = useCurrentUser();

  // Identity: explicit prop (embedded demos) > signed-in Firebase user > local demo default
  const resolvedOwnerId = ownerId ?? currentUser?.id ?? 'usr-local';
  const resolvedOwnerName =
    ownerName ?? currentUser?.display_name ?? currentUser?.email ?? 'You';

  const [prompt, setPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdRole, setCreatedRole] = useState<AgentRoleCard | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleCreate = async () => {
    if (!prompt.trim() || creating) return;
    setCreating(true);
    setError(null);
    setCreatedRole(null);
    try {
      const res = await fetch('/api/lab/roles', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          domainDescription: prompt.trim(),
          ownerId: resolvedOwnerId,
          ownerName: resolvedOwnerName,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error || `Creation failed (${res.status})`);
      setCreatedRole(data.role);
      setPrompt('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Creation failed');
    } finally {
      setCreating(false);
    }
  };

  const handleToggleVisibility = async (role: AgentRoleCard) => {
    setError(null);
    try {
      const res = await fetch('/api/lab/roles', {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ roleId: role.roleId, isPublic: !role.isPublic }),
      });
      const data = await res.json().catch(() => null);
      if (data?.ok && data.role) {
        setCreatedRole(data.role);
      } else {
        setError(data?.error || 'Visibility change failed');
      }
    } catch {
      setError('Visibility change failed');
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Hero creator card */}
      <section className="rounded-2xl border border-white/[0.08] bg-gradient-to-br from-violet-950/30 via-[#080d1e] to-[#05060f] p-5 lg:p-7">
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-violet-500/30 bg-violet-500/10 mb-4">
          <Wand2 className="h-3.5 w-3.5 text-violet-300" aria-hidden />
          <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-violet-200">
            New Agent Type
          </span>
        </div>

        <h2 className="text-lg font-bold text-white tracking-tight mb-1">Create a new agent type</h2>
        <p className="text-[13px] text-zinc-400 mb-4 max-w-xl leading-relaxed">
          Describe what you want the agent to do — the system generates a prompt card, context
          specs, and tool bindings. It starts private in your library.
        </p>

        <div className="relative">
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !creating) {
                e.preventDefault();
                handleCreate();
              }
            }}
            aria-label="Describe the agent"
            placeholder='e.g. "A Rust async auditor that checks Tokio worker pools for deadlocks"'
            rows={4}
            className="w-full px-4 py-3.5 rounded-xl bg-black/50 border border-white/10 text-[14px] text-white placeholder:text-zinc-600 resize-none transition leading-relaxed focus:outline-none focus:border-violet-500/60 focus:bg-black/60 focus:shadow-[0_0_28px_rgba(139,92,246,0.25)]"
          />
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating || !prompt.trim()}
            aria-label="Create agent"
            className={`absolute right-2.5 bottom-2.5 flex items-center gap-1.5 px-3.5 py-2 rounded-lg font-semibold text-xs transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/70 ${
              creating || !prompt.trim()
                ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                : 'bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white hover:brightness-110 shadow-[0_0_20px_rgba(139,92,246,0.4)]'
            }`}
            title="Create agent (⌘+Enter)"
          >
            {creating ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Send className="h-3.5 w-3.5" aria-hidden />
            )}
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>

        {error && (
          <p
            role="alert"
            className="mt-3 text-xs text-rose-400 font-mono px-3 py-2 rounded-lg bg-rose-950/30 border border-rose-500/20"
          >
            {error}
          </p>
        )}

        {/* Example chips */}
        <div className="flex flex-wrap items-center gap-2 mt-4">
          <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-600">
            Try:
          </span>
          {EXAMPLE_PROMPTS.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setPrompt(example);
                textareaRef.current?.focus();
              }}
              className="inline-flex items-center px-3 py-1.5 rounded-full text-[11px] text-zinc-300 bg-white/[0.04] border border-white/10 hover:border-violet-400/40 hover:text-violet-200 hover:bg-violet-500/10 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
            >
              {example}
            </button>
          ))}
        </div>
      </section>

      {/* Created spotlight */}
      {createdRole && (
        <section
          aria-label="Newly created agent"
          className="rounded-2xl border border-emerald-500/25 bg-emerald-950/10 p-4 lg:p-5 space-y-3 shadow-[0_0_32px_-12px_rgba(16,185,129,0.35)]"
        >
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-emerald-400" aria-hidden />
            <span className="text-xs font-semibold text-emerald-300">
              ✨ Created — now in your personal library
            </span>
          </div>
          <AgentRoleCardView
            role={createdRole}
            featured
            isOwner
            onToggleVisibility={handleToggleVisibility}
          />
        </section>
      )}

    </div>
  );
}
