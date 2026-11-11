'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentRoleCard } from '@/lib/lab/roleLibrary';
import AgentRoleCardView from './AgentRoleCard';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { authHeaders } from '@/lib/auth';
import { Globe, Lock, Search, Wand2 } from 'lucide-react';

type LibraryFilter = 'mine' | 'global';

export default function GlobalAgentMarketplace() {
  const currentUser = useCurrentUser();

  // Identity: signed-in Firebase user, falling back to the local demo owner.
  // (The server derives the authoritative ownerId from the bearer token; this
  // value is only used for optimistic client-side "my roles" filtering.)
  const ownerId = currentUser?.id ?? 'usr-local';

  const [roles, setRoles] = useState<AgentRoleCard[]>([]);
  const [filter, setFilter] = useState<LibraryFilter>('mine');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forkedRoleIds, setForkedRoleIds] = useState<Set<string>>(new Set());

  const fetchRoles = useCallback(async () => {
    try {
      const res = await fetch(`/api/lab/roles?scope=all`, {
        headers: authHeaders(),
      });
      const data = await res.json().catch(() => null);
      if (data && data.ok && Array.isArray(data.roles)) {
        setRoles(data.roles);
      } else {
        setError('Failed to load library');
      }
    } catch {
      setError('Failed to load library');
    } finally {
      setLoading(false);
    }
  }, [ownerId]);

  useEffect(() => {
    fetchRoles();
  }, [fetchRoles]);

  const handleToggleVisibility = async (role: AgentRoleCard) => {
    const nextPublic = !role.isPublic;
    // Optimistic flip — rollback on failure
    setRoles((prev) =>
      prev.map((r) => (r.roleId === role.roleId ? { ...r, isPublic: nextPublic } : r))
    );
    setError(null);
    try {
      const res = await fetch('/api/lab/roles', {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ roleId: role.roleId, isPublic: nextPublic }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error || 'Visibility change failed');
    } catch (err: unknown) {
      setRoles((prev) =>
        prev.map((r) => (r.roleId === role.roleId ? { ...r, isPublic: !nextPublic } : r))
      );
      setError(err instanceof Error ? err.message : 'Visibility change failed');
    }
  };

  const handleFork = async (role: AgentRoleCard) => {
    if (forkedRoleIds.has(role.roleId)) return;
    setError(null);
    setForkedRoleIds((prev) => new Set(prev).add(role.roleId));
    try {
      const res = await fetch('/api/lab/roles/fork', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ roleId: role.roleId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error || 'Fork failed');
      await fetchRoles();
    } catch (err: unknown) {
      setForkedRoleIds((prev) => {
        const next = new Set(prev);
        next.delete(role.roleId);
        return next;
      });
      setError(err instanceof Error ? err.message : 'Fork failed');
    }
  };

  const myRoles = useMemo(
    () => roles.filter((r) => r.ownerId === ownerId || r.isBuiltin),
    [roles]
  );

  const globalRoles = useMemo(() => {
    const base = roles.filter((r) => r.isPublic);
    const q = search.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.roleId.toLowerCase().includes(q) ||
        r.category.toLowerCase().includes(q) ||
        r.ownerName.toLowerCase().includes(q)
    );
  }, [roles, search]);

  const displayed = filter === 'mine' ? myRoles : globalRoles;
  const hasUnpublished = myRoles.some((r) => !r.isPublic && !r.isBuiltin);

  return (
    <div className="space-y-5">
      {/* Top bar: filter pills + search */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div
          role="group"
          aria-label="Library filter"
          className="flex items-center gap-1 p-1 rounded-xl bg-black/60 border border-white/10 w-fit"
        >
          <button
            type="button"
            onClick={() => setFilter('mine')}
            aria-pressed={filter === 'mine'}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 ${
              filter === 'mine'
                ? 'bg-cyan-500/20 text-cyan-200 border-cyan-400/40'
                : 'bg-transparent text-zinc-400 border-transparent hover:text-zinc-200'
            }`}
          >
            <Lock className="h-3.5 w-3.5" aria-hidden />
            My Library
            <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-white/10 text-[10px] font-mono leading-none">
              {myRoles.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setFilter('global')}
            aria-pressed={filter === 'global'}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 ${
              filter === 'global'
                ? 'bg-cyan-500/20 text-cyan-200 border-cyan-400/40'
                : 'bg-transparent text-zinc-400 border-transparent hover:text-zinc-200'
            }`}
          >
            <Globe className="h-3.5 w-3.5" aria-hidden />
            Global Library
            <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-white/10 text-[10px] font-mono leading-none">
              {globalRoles.length}
            </span>
          </button>
        </div>

        {filter === 'global' && (
          <div className="relative w-full sm:w-72">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500 pointer-events-none"
              aria-hidden
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search global agents…"
              aria-label="Search global agents"
              className="w-full pl-9 pr-3 py-2 rounded-xl bg-black/50 border border-white/10 text-xs text-white placeholder:text-zinc-600 transition focus:outline-none focus:border-cyan-500/50 focus-visible:ring-2 focus-visible:ring-cyan-400/40"
            />
          </div>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="text-xs text-rose-400 font-mono px-3 py-2 rounded-lg bg-rose-950/30 border border-rose-500/20"
        >
          {error}
        </p>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 space-y-4 animate-pulse"
            >
              <div className="flex gap-3">
                <div className="h-11 w-11 rounded-xl bg-white/10" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-2/3 rounded bg-white/10" />
                  <div className="h-3 w-1/3 rounded bg-white/5" />
                </div>
              </div>
              <div className="h-12 rounded-xl bg-white/5" />
            </div>
          ))}
        </div>
      ) : displayed.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 py-16 px-6 text-center">
          {filter === 'mine' ? (
            <Wand2 className="h-8 w-8 text-zinc-700 mx-auto mb-3" aria-hidden />
          ) : (
            <Globe className="h-8 w-8 text-zinc-700 mx-auto mb-3" aria-hidden />
          )}
          <p className="text-sm text-zinc-400 font-medium">
            {filter === 'mine'
              ? 'Your library is empty. Create an agent above.'
              : 'No global agents yet. Be the first to publish!'}
          </p>
        </div>
      ) : (
        <div role="list" className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {displayed.map((role) => {
            const isOwnCard = role.ownerId === ownerId && !role.isBuiltin;
            return (
              <div key={role.roleId} role="listitem">
                <AgentRoleCardView
                  role={role}
                  compact
                  isOwner={isOwnCard}
                  onToggleVisibility={isOwnCard ? handleToggleVisibility : undefined}
                  onFork={filter === 'global' ? handleFork : undefined}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Publish hint */}
      {filter === 'mine' && !loading && hasUnpublished && (
        <p className="text-center text-[11px] text-zinc-500">
          <Globe className="h-3 w-3 inline mr-1 text-emerald-400" aria-hidden />
          Click the globe icon on any agent to publish it to the global library.
        </p>
      )}

    </div>
  );
}
