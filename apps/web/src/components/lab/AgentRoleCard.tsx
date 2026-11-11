'use client';

import React, { useState } from 'react';
import type { AgentRoleCard as RoleCard } from '@/lib/lab/roleLibrary';
import {
  Globe,
  Lock,
  Sparkles,
  GitFork,
  Activity,
  Layers,
  Workflow,
  Brain,
  Hand,
  Bot,
  ArrowRight,
  ChevronDown,
  Minimize2,
} from 'lucide-react';

const USAGE_ICONS: Record<string, React.ElementType> = {
  workflow: Workflow,
  decomposition: Layers,
  manual: Hand,
  orchestration: Brain,
};

const TIER_STYLES: Record<string, { badge: string; glow: string }> = {
  frontier: {
    badge: 'text-fuchsia-200 border-fuchsia-400/50 bg-fuchsia-500/10',
    glow: 'shadow-[0_0_20px_rgba(217,70,239,0.2)]',
  },
  strong: {
    badge: 'text-cyan-200 border-cyan-400/50 bg-cyan-500/10',
    glow: 'shadow-[0_0_20px_rgba(34,211,238,0.15)]',
  },
  medium: {
    badge: 'text-amber-200 border-amber-400/50 bg-amber-500/10',
    glow: 'shadow-[0_0_16px_rgba(251,191,36,0.12)]',
  },
  light: {
    badge: 'text-zinc-300 border-zinc-500/40 bg-zinc-500/10',
    glow: '',
  },
};

interface AgentRoleCardProps {
  role: RoleCard;
  featured?: boolean;
  compact?: boolean;
  onSelect?: (role: RoleCard) => void;
  onToggleVisibility?: (role: RoleCard) => void;
  /** Present in the global library — forks the role into the viewer's library as a private draft */
  onFork?: (role: RoleCard) => void;
  isOwner?: boolean;
}

export default function AgentRoleCardView({
  role,
  featured = false,
  compact = false,
  onSelect,
  onToggleVisibility,
  onFork,
  isOwner = false,
}: AgentRoleCardProps) {
  const [expanded, setExpanded] = useState(featured);
  const tier = TIER_STYLES[role.recommendedModelTier] || TIER_STYLES.strong;
  const isCondenser = role.roleId === 'context-condenser';

  return (
    <article
      className={`group relative overflow-hidden rounded-2xl border transition-all duration-300 ${
        featured
          ? `border-fuchsia-500/35 bg-gradient-to-br from-[#14091f] via-[#0a0e22] to-[#05060f] ${tier.glow}`
          : 'border-white/[0.08] bg-gradient-to-b from-white/[0.04] to-transparent hover:border-cyan-500/25 hover:shadow-[0_8px_32px_-12px_rgba(6,182,212,0.25)] hover:-translate-y-0.5'
      }`}
    >
      {/* Ambient glow */}
      <div
        aria-hidden
        className={`pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full blur-3xl transition-opacity ${
          featured ? 'opacity-60 bg-fuchsia-600/30' : 'opacity-0 group-hover:opacity-40 bg-cyan-500/20'
        }`}
      />

      {featured && (
        <>
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-fuchsia-400/70 to-transparent" />
          <div className="absolute left-4 top-3.5">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-mono font-bold uppercase tracking-widest text-fuchsia-300/90">
              <Sparkles className="h-3 w-3" />
              Proof of Concept
            </span>
          </div>
        </>
      )}

      <div className={`relative p-5 space-y-4 ${featured ? 'pt-10' : ''}`}>
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border bg-gradient-to-br ${role.color}`}
              style={{
                borderColor: 'rgba(255,255,255,0.15)',
                boxShadow: featured ? '0 0 24px rgba(192,38,211,0.35)' : undefined,
              }}
            >
              {isCondenser ? (
                <Minimize2 className="h-5 w-5 text-white drop-shadow" />
              ) : (
                <Bot className="h-5 w-5 text-white drop-shadow" />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-[15px] font-bold text-white tracking-tight truncate">
                  {role.name}
                </h3>
                {role.isBuiltin && (
                  <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded-md border border-fuchsia-400/40 bg-fuchsia-500/15 text-fuchsia-200">
                    Built-in
                  </span>
                )}
              </div>
              <p className="text-[10px] text-zinc-500 font-mono truncate mt-0.5">{role.roleId}</p>
            </div>
          </div>

          {role.isPublic ? (
            <span className="inline-flex items-center gap-1 text-[9px] font-mono uppercase px-2 py-1 rounded-full border border-emerald-400/35 bg-emerald-500/10 text-emerald-300 shrink-0">
              <Globe className="h-3 w-3" /> Global
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[9px] font-mono uppercase px-2 py-1 rounded-full border border-zinc-600/50 bg-zinc-800/50 text-zinc-400 shrink-0">
              <Lock className="h-3 w-3" /> Private
            </span>
          )}
        </div>

        {/* Description */}
        <p
          className={`text-[13px] text-zinc-300/90 leading-relaxed ${
            compact && !expanded ? 'line-clamp-2' : featured ? '' : 'line-clamp-3'
          }`}
        >
          {role.description}
        </p>

        {/* Context flow visualization */}
        <div
          className={`rounded-xl border p-3 ${
            featured
              ? 'border-fuchsia-500/20 bg-fuchsia-950/20'
              : 'border-white/[0.06] bg-black/30'
          }`}
        >
          <div className="flex items-center gap-2">
            <div className="flex-1 rounded-lg border border-cyan-500/20 bg-cyan-950/30 px-3 py-2.5 text-center">
              <span className="text-[9px] font-mono uppercase text-cyan-500/80 block mb-0.5">
                Input Context
              </span>
              <span className="text-xs font-mono font-semibold text-cyan-200">
                {role.contextInputRange}
              </span>
            </div>
            <div className="flex flex-col items-center gap-0.5 shrink-0 px-1">
              <ArrowRight className="h-4 w-4 text-fuchsia-400/80" />
              {isCondenser && (
                <span className="text-[8px] font-mono text-fuchsia-400/60 uppercase">compress</span>
              )}
            </div>
            <div className="flex-1 rounded-lg border border-fuchsia-500/20 bg-fuchsia-950/30 px-3 py-2.5 text-center">
              <span className="text-[9px] font-mono uppercase text-fuchsia-500/80 block mb-0.5">
                Output
              </span>
              <span className="text-xs font-mono font-semibold text-fuchsia-200">
                {role.contextOutputRange}
              </span>
            </div>
          </div>
        </div>

        {/* Usage contexts */}
        {!compact && (
          <div className="flex flex-wrap gap-1.5">
            {role.usageContexts.map((ctx) => {
              const Icon = USAGE_ICONS[ctx] || Sparkles;
              return (
                <span
                  key={ctx}
                  className="inline-flex items-center gap-1 text-[9px] font-mono uppercase px-2 py-1 rounded-md border border-white/10 bg-white/[0.04] text-zinc-400 group-hover:border-white/15 transition-colors"
                >
                  <Icon className="h-2.5 w-2.5 opacity-70" />
                  {ctx}
                </span>
              );
            })}
          </div>
        )}

        {/* Expanded directive preview */}
        {expanded && role.contextDna?.systemDirective && (
          <div className="rounded-xl border border-white/[0.06] bg-black/40 p-3.5 space-y-2">
            <span className="text-[9px] font-mono uppercase tracking-wider text-zinc-500">
              System Directive Preview
            </span>
            <p className="text-[11px] font-mono text-zinc-400 leading-relaxed line-clamp-6 whitespace-pre-wrap">
              {role.contextDna.systemDirective}
            </p>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between pt-1 border-t border-white/[0.06]">
          <div className="flex items-center gap-2.5 text-[10px] font-mono text-zinc-500">
            <span className={`px-2 py-0.5 rounded-md border ${tier.badge}`}>
              {role.recommendedModelTier}
            </span>
            <span className="inline-flex items-center gap-1 text-zinc-600">
              <GitFork className="h-3 w-3" /> {role.forkCount.toLocaleString()}
            </span>
            <span className="inline-flex items-center gap-1 text-zinc-600">
              <Activity className="h-3 w-3" /> {role.useCount.toLocaleString()}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            {(featured || role.contextDna?.systemDirective) && (
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                aria-label={expanded ? `Collapse ${role.name}` : `View directive for ${role.name}`}
                className="p-1.5 rounded-lg border border-white/10 text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.05] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
                title={expanded ? 'Collapse' : 'View directive'}
              >
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
                  aria-hidden
                />
              </button>
            )}
            {onFork && (
              <button
                type="button"
                onClick={() => onFork(role)}
                aria-label={`Fork ${role.name} to your library`}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-cyan-400/30 bg-cyan-500/10 text-cyan-200 text-[10px] font-semibold hover:bg-cyan-500/20 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
                title="Fork to your library as a private draft"
              >
                <GitFork className="h-3 w-3" aria-hidden />
                Fork
              </button>
            )}
            {isOwner && onToggleVisibility && !role.isBuiltin && (
              <button
                type="button"
                onClick={() => onToggleVisibility(role)}
                aria-label={
                  role.isPublic
                    ? `Make ${role.name} private`
                    : `Publish ${role.name} to the global library`
                }
                className="p-1.5 rounded-lg border border-white/10 text-zinc-500 hover:text-white hover:bg-white/[0.05] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
                title={role.isPublic ? 'Make private' : 'Publish to global library'}
              >
                {role.isPublic ? <Lock className="h-3.5 w-3.5" aria-hidden /> : <Globe className="h-3.5 w-3.5" aria-hidden />}
              </button>
            )}
            {onSelect && (
              <button
                type="button"
                onClick={() => onSelect(role)}
                className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500/25 to-blue-600/25 border border-cyan-400/40 text-cyan-200 text-[10px] font-semibold hover:from-cyan-500/35 hover:to-blue-600/35 transition shadow-[0_0_12px_rgba(6,182,212,0.15)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
              >
                Use Role
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
