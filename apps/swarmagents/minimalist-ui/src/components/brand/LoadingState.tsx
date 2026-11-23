"use client";

/**
 * LoadingState — skeleton for surfaces, spinner for actions.
 *
 * Skeleton blocks shimmer at the shape of the content they replace (pass
 * `lines` for text, or compose `Skeleton` blocks directly). The spinner is
 * the brand ring: Signal arc on a faint track. Both freeze under
 * prefers-reduced-motion (tokens.css) and announce via role="status".
 */

import { cn } from "../../utils/cn";

export function Spinner({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("brand-spinner inline-block shrink-0", className)}
      style={{ width: size, height: size }}
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("brand-skeleton rounded-[var(--brand-radius-sm)]", className)} />;
}

export interface LoadingStateProps {
  /** What is loading, in plain words: "Starting your computer…". */
  label?: string;
  /** Number of skeleton text lines under the spinner row. */
  lines?: number;
  className?: string;
}

export function LoadingState({ label = "Loading…", lines = 3, className }: LoadingStateProps) {
  return (
    <div role="status" aria-label={label} className={cn("px-4 py-6", className)}>
      <div className="flex items-center gap-2.5 text-[13px] font-medium text-[var(--brand-text-2)]">
        <Spinner size={16} />
        {label}
      </div>
      {lines > 0 ? (
        <div className="mt-5 space-y-2.5" aria-hidden>
          {Array.from({ length: lines }, (_, i) => (
            <Skeleton
              key={i}
              className={cn("h-3", i === lines - 1 ? "w-2/5" : i % 2 === 0 ? "w-full" : "w-4/5")}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
