'use client';

import { Sparkles, BookOpen, User, Trash2 } from 'lucide-react';
import type { TribalRule } from '@/lib/tribal';

function confidenceTone(c: number): string {
  if (c >= 0.7) return 'text-emerald-300 border-emerald-400/30 bg-emerald-400/10';
  if (c >= 0.45) return 'text-amber-300 border-amber-400/30 bg-amber-400/10';
  return 'text-rose-300 border-rose-400/30 bg-rose-400/10';
}

export default function RuleCard({
  rule,
  onDelete,
}: {
  rule: TribalRule;
  onDelete?: (id: string) => void;
}) {
  const isUser = rule.source === 'user' || rule.id.startsWith('usr-');
  const isLearned = rule.source === 'learned';

  return (
    <div className="group relative rounded-xl border border-cyan-400/10 bg-white/[0.02] p-4 transition-all hover:border-cyan-400/25 hover:bg-white/[0.04]">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm leading-relaxed text-cyan-50/90">{rule.rule}</p>
        <div className="flex items-center gap-2">
          <span
            className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-mono ${confidenceTone(rule.confidence)}`}
            title="confidence"
          >
            {Math.round(rule.confidence * 100)}%
          </span>
          {onDelete && isUser && (
            <button
              onClick={() => onDelete(rule.id)}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-rose-400/60 hover:text-rose-300 hover:bg-rose-400/10 rounded-md"
              title="Delete this rule"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-cyan-100/40">
        {isUser ? (
          <span className="inline-flex items-center gap-1 text-cyan-300/90 font-medium">
            <User className="h-3 w-3" />
            User · Cross-Project
          </span>
        ) : isLearned ? (
          <span className="inline-flex items-center gap-1 text-violet-300/80">
            <Sparkles className="h-3 w-3" />
            Learned
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-cyan-100/50">
            <BookOpen className="h-3 w-3" />
            AGENTS.md
          </span>
        )}
        {rule.section && <span className="text-cyan-100/30">§ {rule.section}</span>}
        {rule.learned_at && (
          <span title={rule.learned_at}>{new Date(rule.learned_at).toLocaleDateString()}</span>
        )}
        {rule.source_task && (
          <span className="rounded bg-cyan-400/10 px-1.5 py-0.5 font-mono text-cyan-200/70">
            task {rule.source_task}
          </span>
        )}
      </div>
    </div>
  );
}

