"use client";

/**
 * StatusPill — status is always a dot plus a word, in one of five tones.
 * `running` breathes (live ring) while a run streams; the ring is disabled
 * under prefers-reduced-motion by tokens.css. `live` overrides the pulse:
 * a live `ok`/`warn` still breathes, a steady `running` (e.g. the human
 * holding the controls) does not. Labels render verbatim — no casing
 * transform, so "Live · 42 ms" stays "42 ms". The pill itself is glass
 * (backdrop blur + soft shadow) so it reads over live pixels as well as
 * over the chrome bar.
 */

import type { ReactNode } from "react";
import { cn } from "../../utils/cn";

export type PillStatus = "running" | "idle" | "ok" | "warn" | "error";

const TONE: Record<PillStatus, { pill: string; dot: string }> = {
  running: {
    pill: "border-[rgba(0,208,240,0.4)] bg-[rgba(0,208,240,0.1)] text-[var(--brand-signal)]",
    dot: "bg-[var(--brand-signal)] text-[var(--brand-signal)]",
  },
  idle: {
    pill: "border-[var(--brand-hairline)] bg-[rgba(255,255,255,0.03)] text-[var(--brand-text-2)]",
    dot: "bg-[var(--brand-mist)] text-[var(--brand-mist)]",
  },
  ok: {
    pill: "border-[rgba(52,211,153,0.35)] bg-[rgba(52,211,153,0.1)] text-[var(--brand-ok)]",
    dot: "bg-[var(--brand-ok)] text-[var(--brand-ok)]",
  },
  warn: {
    pill: "border-[rgba(251,191,36,0.35)] bg-[rgba(251,191,36,0.1)] text-[var(--brand-warn)]",
    dot: "bg-[var(--brand-warn)] text-[var(--brand-warn)]",
  },
  error: {
    pill: "border-[rgba(251,113,133,0.35)] bg-[rgba(251,113,133,0.1)] text-[var(--brand-err)]",
    dot: "bg-[var(--brand-err)] text-[var(--brand-err)]",
  },
};

export interface StatusPillProps {
  status: PillStatus;
  children: ReactNode;
  /** Pulse the dot. Defaults to true only for `running`. */
  live?: boolean;
  testId?: string;
  className?: string;
}

export function StatusPill({ status, children, live, testId, className }: StatusPillProps) {
  const tone = TONE[status];
  const pulsing = live ?? status === "running";
  return (
    <span
      data-status={status}
      data-testid={testId}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-[var(--brand-radius-full)] border px-2 py-[3px] text-[11px] font-semibold leading-none backdrop-blur-sm shadow-[0_2px_12px_rgba(0,0,0,0.35)]",
        tone.pill,
        className,
      )}
    >
      <span
        aria-hidden
        className={cn("h-[5px] w-[5px] shrink-0 rounded-full", tone.dot, pulsing && "brand-live-dot")}
      />
      {children}
    </span>
  );
}
