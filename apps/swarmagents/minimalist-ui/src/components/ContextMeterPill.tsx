"use client";

/**
 * ContextMeterPill — the per-turn token-budget HUD meter.
 *
 * A minimal Apple/Google-style pill that sits in a turn's status row:
 * "12.4k ctx · 81% cached". Clicking (or hovering, via the title) opens a
 * breakdown popover: input / output / cached tokens, the cache hit rate,
 * the context-window utilization meter, and the estimated cache savings
 * when the budget carries a price.
 *
 * Renders nothing when the turn reported no usage — a provider that never
 * reports usage leaves no meter behind. The popover closes on Escape and
 * on any click outside it, and the pill is a real <button> so it works
 * with a keyboard and a screen reader.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Gauge } from "lucide-react";
import type { TokenBudget } from "../../../lib/client/tokenBudget";
import { cn } from "../utils/cn";
import { formatReportCost, formatTokenCount } from "./RunReportCard";

export interface ContextMeterPillProps {
  /** Aggregated budget for the turn; null (or no usage) renders nothing. */
  budget: TokenBudget | null;
  className?: string;
  /** Open the popover on first render (tests / static rendering). */
  defaultOpen?: boolean;
}

function pctLabel(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

function meterTone(value: number | null): string {
  if (value === null) return "bg-white/20";
  if (value >= 90) return "bg-red-400";
  if (value >= 70) return "bg-amber-400";
  return "bg-[var(--brand-signal)]";
}

export function ContextMeterPill({ budget, className, defaultOpen = false }: ContextMeterPillProps) {
  const [open, setOpen] = useState(defaultOpen);
  const popoverId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open ]);

  if (budget === null || !budget.hasUsage) return null;

  const hitRate = budget.cacheHitRatePct;
  const utilization = budget.contextUtilizationPct;
  const saved = budget.estimatedSavedUsd;

  return (
    <div ref={rootRef} className={cn("relative inline-flex", className)}>
      <button
        ref={buttonRef}
        type="button"
        data-testid="context-meter-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popoverId}
        title={
          hitRate === null
            ? `${formatTokenCount(budget.totalInputTokens)} context tokens this turn`
            : `${formatTokenCount(budget.totalInputTokens)} context tokens · ${hitRate}% served from cache`
        }
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-sa-line bg-sa-raised px-2.5 text-[12px] font-medium tabular-nums text-sa-fg2 transition-colors hover:bg-sa-hover hover:text-sa-fg"
      >
        <Gauge className="h-3.5 w-3.5 shrink-0 text-[var(--brand-signal)]" aria-hidden />
        <span className="whitespace-nowrap">
          {formatTokenCount(budget.totalInputTokens)} ctx
          {hitRate !== null && (
            <>
              <span className="mx-1 text-sa-fg3" aria-hidden>
                ·
              </span>
              {hitRate}% cached
            </>
          )}
        </span>
      </button>

      {open && (
        <div
          id={popoverId}
          role="dialog"
          aria-label="Token budget breakdown"
          data-testid="context-meter-popover"
          className="absolute bottom-full right-0 z-50 mb-2 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-sa-line bg-sa-raised p-3 text-left shadow-2xl"
        >
          <p className="text-[12px] font-semibold text-sa-fg">
            Token budget{budget.model ? ` · ${budget.model}` : ""}
          </p>
          <dl className="mt-2 space-y-1.5 text-[12px] tabular-nums">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-sa-fg3">Input tokens</dt>
              <dd className="font-medium text-sa-fg">{formatTokenCount(budget.totalInputTokens)}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-sa-fg3">Output tokens</dt>
              <dd className="font-medium text-sa-fg">{formatTokenCount(budget.totalOutputTokens)}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-sa-fg3">Cached tokens</dt>
              <dd className="font-medium text-sa-fg">{formatTokenCount(budget.totalCachedTokens)}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-sa-fg3">Cache hit rate</dt>
              <dd className="font-medium text-sa-fg">{pctLabel(hitRate)}</dd>
            </div>
            {saved !== null && (
              <div className="flex items-center justify-between gap-2">
                <dt className="text-sa-fg3">Est. cache savings</dt>
                <dd className="font-medium text-sa-fg">{formatReportCost(saved)}</dd>
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <dt className="text-sa-fg3">Turns with usage</dt>
              <dd className="font-medium text-sa-fg">
                {budget.turnsWithUsage} of {budget.turns}
              </dd>
            </div>
          </dl>

          <div className="mt-3 space-y-2.5">
            <div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-sa-fg3">Cache hit rate</span>
                <span className="font-medium tabular-nums text-sa-fg">{pctLabel(hitRate)}</span>
              </div>
              <div
                className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10"
                role="meter"
                aria-valuenow={hitRate ?? undefined}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Cache hit rate"
              >
                <div
                  className={cn("h-full rounded-full transition-[width]", meterTone(hitRate))}
                  style={{ width: `${Math.min(100, hitRate ?? 0)}%` }}
                />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-sa-fg3">
                  Context used
                  {budget.contextWindowTokens !== undefined &&
                    ` of ${formatTokenCount(budget.contextWindowTokens)}`}
                </span>
                <span className="font-medium tabular-nums text-sa-fg">{pctLabel(utilization)}</span>
              </div>
              <div
                className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10"
                role="meter"
                aria-valuenow={utilization ?? undefined}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Context window utilization"
              >
                <div
                  className={cn("h-full rounded-full transition-[width]", meterTone(utilization))}
                  style={{ width: `${Math.min(100, utilization ?? 0)}%` }}
                />
              </div>
              {utilization === null && (
                <p className="mt-1 text-[11px] leading-snug text-sa-fg3">
                  No context window known for this model, so utilization is unavailable.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ContextMeterPill;
