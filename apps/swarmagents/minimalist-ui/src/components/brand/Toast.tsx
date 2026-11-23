"use client";

/**
 * Toast — small, factual notices in the corner. Say what happened, not how
 * amazing it is (brand voice). Tones: info (Signal), ok, warn, err — each
 * with its brand icon. Errors use role="alert"; the rest announce politely.
 * Auto-dismiss is per-toast (`durationMs`, default 6000; 0 = sticky).
 */

import { useEffect } from "react";
import { cn } from "../../utils/cn";
import { Icon } from "./Icon";
import type { IconName } from "./tokens";

export type ToastTone = "info" | "ok" | "warn" | "err";

export interface ToastData {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  /** Auto-dismiss after this many ms. 0 = sticky. Default 6000. */
  durationMs?: number;
  /** Optional action, rendered as a small link-style button under the text. */
  actionLabel?: string;
  onAction?: () => void;
}

const TONE: Record<ToastTone, { icon: IconName; color: string; border: string }> = {
  info: { icon: "chat-bar", color: "text-[var(--brand-signal)]", border: "border-[rgba(0,208,240,0.35)]" },
  ok: { icon: "check", color: "text-[var(--brand-ok)]", border: "border-[rgba(52,211,153,0.35)]" },
  warn: { icon: "warning", color: "text-[var(--brand-warn)]", border: "border-[rgba(251,191,36,0.35)]" },
  err: { icon: "warning", color: "text-[var(--brand-err)]", border: "border-[rgba(251,113,133,0.4)]" },
};

function CloseGlyph() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden
      focusable="false"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function Toast({
  toast,
  onDismiss,
}: {
  toast: ToastData;
  onDismiss: (id: string) => void;
}) {
  const tone = TONE[toast.tone];
  const duration = toast.durationMs ?? 6000;

  useEffect(() => {
    if (duration <= 0) return;
    const timer = setTimeout(() => onDismiss(toast.id), duration);
    return () => clearTimeout(timer);
  }, [duration, onDismiss, toast.id]);

  return (
    <div
      role={toast.tone === "err" ? "alert" : "status"}
      className={cn(
        "brand-toast-in pointer-events-auto flex w-[min(360px,92vw)] items-start gap-2.5 rounded-[var(--brand-radius-lg)] border bg-[var(--brand-surface-raised)] p-3 shadow-[var(--brand-shadow-pop)]",
        tone.border,
      )}
    >
      <Icon name={tone.icon} size={17} className={cn("mt-px shrink-0", tone.color)} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium leading-snug text-[var(--brand-text)]">{toast.title}</p>
        {toast.description ? (
          <p className="mt-0.5 text-[12px] leading-snug text-[var(--brand-text-2)]">{toast.description}</p>
        ) : null}
        {toast.onAction && toast.actionLabel ? (
          <button
            type="button"
            onClick={toast.onAction}
            className="mt-1.5 text-[12px] font-medium text-[var(--brand-signal)] hover:underline focus-visible:outline-none focus-visible:shadow-[var(--brand-focus-ring)]"
          >
            {toast.actionLabel}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-[var(--brand-radius-sm)] text-[var(--brand-text-3)] transition-colors hover:bg-[var(--brand-surface-hover)] hover:text-[var(--brand-text)] focus-visible:outline-none focus-visible:shadow-[var(--brand-focus-ring)]"
      >
        <CloseGlyph />
      </button>
    </div>
  );
}

export function ToastViewport({
  toasts,
  onDismiss,
  className,
}: {
  toasts: readonly ToastData[];
  onDismiss: (id: string) => void;
  className?: string;
}) {
  return (
    <div
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed bottom-4 right-4 flex flex-col items-end gap-2",
        className,
      )}
      style={{ zIndex: 80 /* --brand-z-toast */ }}
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
