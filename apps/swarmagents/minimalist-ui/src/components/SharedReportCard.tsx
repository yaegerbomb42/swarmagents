"use client";

/**
 * SharedReportCard — the redacted, public cousin of RunReportCard.
 *
 * A share link's showcase must never leak the owner's account: this card
 * renders only the fields the share view explicitly curated (status badge,
 * the task prompt, step/screenshot/artifact counts, duration, model). It
 * fetches nothing — every value arrives already redacted from the server —
 * so there is no code path that could pull the owner's private report.
 */

import type { ShareShowcase } from "../../../lib/projects/store";

export interface SharedReportCardProps {
  showcase: ShareShowcase;
}

function duration(ms: number | undefined): string {
  if (!ms || ms < 0) return "—";
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

export function SharedReportCard({ showcase }: SharedReportCardProps) {
  const ok = showcase.status === "finished";
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full border px-2 py-0.5 text-[11px] ${
            ok
              ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
              : "border-white/15 bg-white/5 text-white/60"
          }`}
        >
          {showcase.status}
        </span>
        {showcase.model && (
          <span className="font-mono text-[11px] text-white/40">{showcase.model}</span>
        )}
        <span className="text-[11px] text-white/40">{duration(showcase.durationMs)}</span>
      </div>
      <p className="mt-3 whitespace-pre-wrap break-words text-sm text-white/85">{showcase.prompt}</p>
      <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-2">
          <dt className="text-[10px] uppercase tracking-wide text-white/35">Steps</dt>
          <dd className="text-sm text-white/85">{showcase.steps}</dd>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-2">
          <dt className="text-[10px] uppercase tracking-wide text-white/35">Screenshots</dt>
          <dd className="text-sm text-white/85">{showcase.shots}</dd>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-2">
          <dt className="text-[10px] uppercase tracking-wide text-white/35">Artifacts</dt>
          <dd className="text-sm text-white/85">{showcase.artifacts}</dd>
        </div>
      </dl>
    </div>
  );
}
