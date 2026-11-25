"use client";

/**
 * ui.tsx — the workspace's whole control vocabulary.
 *
 * One button, one icon button, one status badge, one inline notice, one
 * segmented switch, one sheet. Every surface of the main page is built from
 * these, so the same action always looks and behaves the same way, status is
 * always a dot plus a word in one of five tones, and an error is always a
 * Notice.
 */

import React, { useEffect, useRef, useState } from "react";
import { CircleAlert, Info, Loader2, TriangleAlert, X } from "lucide-react";
import type { StatusTone } from "../../../lib/client/runPhase";
import { cn } from "../utils/cn";
import { useFocusTrap } from "../utils/focusTrap";

// ---- Button ----

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-gradient-to-b from-cyan-400 to-cyan-500 text-slate-950 font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_8px_22px_-8px_rgba(0,208,240,0.55)] hover:from-cyan-300 hover:to-cyan-400",
  secondary: "neo-pill text-sa-fg",
  ghost: "text-sa-fg2 hover:bg-white/[0.07] hover:text-sa-fg",
  danger: "border border-sa-err/40 bg-sa-err/[0.08] text-sa-err hover:bg-sa-err/15",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-9 px-3.5 text-sm",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and blocks clicks while an action is in flight. */
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, className, children, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        BUTTON_VARIANT[variant],
        BUTTON_SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name; also the tooltip. */
  label: string;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, className, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      title={label}
      className={cn(
        "grid h-9 w-9 shrink-0 place-items-center rounded-lg text-sa-fg2 transition-colors hover:bg-sa-hover hover:text-sa-fg disabled:cursor-not-allowed disabled:opacity-45",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

// ---- Status ----

const TONE_TEXT: Record<StatusTone, string> = {
  accent: "text-sa-accent-fg",
  ok: "text-sa-ok",
  warn: "text-sa-warn",
  err: "text-sa-err",
  muted: "text-sa-fg2",
};

const TONE_DOT: Record<StatusTone, string> = {
  accent: "bg-sa-accent-fg",
  ok: "bg-sa-ok",
  warn: "bg-sa-warn",
  err: "bg-sa-err",
  muted: "bg-sa-fg3",
};

/** The one way status is shown: a dot and a word. `live` pulses the dot. */
export function StatusBadge({
  tone,
  label,
  live = false,
  className,
  testId,
}: {
  tone: StatusTone;
  label: string;
  live?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <span
      data-tone={tone}
      data-testid={testId}
      className={cn("inline-flex shrink-0 items-center gap-1.5 text-[13px] font-medium", TONE_TEXT[tone], className)}
    >
      <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[tone], live && "sa-dot-live")} />
      {label}
    </span>
  );
}

// ---- Notice ----

type NoticeTone = "info" | "warn" | "err";

const NOTICE_TONE: Record<NoticeTone, { box: string; icon: string; Icon: typeof Info }> = {
  info: { box: "border-sa-line bg-sa-panel", icon: "text-sa-fg2", Icon: Info },
  warn: { box: "border-sa-warn/30 bg-sa-warn/[0.06]", icon: "text-sa-warn", Icon: TriangleAlert },
  err: { box: "border-sa-err/30 bg-sa-err/[0.06]", icon: "text-sa-err", Icon: CircleAlert },
};

/** The one way an inline message is shown: what happened, why, what to do. */
export function Notice({
  tone = "info",
  title,
  children,
  action,
  className,
  testId,
}: {
  tone?: NoticeTone;
  title: string;
  children?: React.ReactNode;
  /** The single next step, rendered on the right (below on narrow screens). */
  action?: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  const { box, icon, Icon } = NOTICE_TONE[tone];
  return (
    <div
      role={tone === "err" ? "alert" : "status"}
      data-testid={testId}
      data-tone={tone}
      className={cn("flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border px-3 py-2.5", box, className)}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", icon)} aria-hidden />
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-[13px] font-medium text-sa-fg">{title}</p>
        {children && <div className="mt-0.5 break-words text-[13px] leading-relaxed text-sa-fg2">{children}</div>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

// ---- Segmented switch ----

export interface SegmentOption<T extends string> {
  id: T;
  label: string;
  icon?: React.ReactNode;
  /** Small count shown after the label (e.g. open tasks). */
  count?: number;
}

/** A tab list: arrow keys move between options, the selected one is in the tab order. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
  testIdPrefix = "view",
}: {
  label: string;
  options: SegmentOption<T>[];
  /** Undefined when no option is showing (the stage is closed). */
  value: T | undefined;
  onChange: (id: T) => void;
  className?: string;
  /** Each option gets `data-testid="<prefix>-<id>"`. */
  testIdPrefix?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((option) => option.id === value);
  const tabStop = selectedIndex === -1 ? 0 : selectedIndex;

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = (index + delta + options.length) % options.length;
    refs.current[next]?.focus();
    onChange(options[next].id);
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn("inline-flex items-center gap-0.5 rounded-[10px] border border-sa-line bg-sa-panel p-0.5", className)}
    >
      {options.map((option, index) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={index === tabStop ? 0 : -1}
            data-testid={`${testIdPrefix}-${option.id}`}
            onClick={() => onChange(option.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-xl px-3 text-[13px] font-medium transition-all",
              selected
                ? "bg-white/[0.11] text-sa-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_4px_12px_-4px_rgba(0,0,0,0.6)]"
                : "text-sa-fg2 hover:bg-white/[0.04] hover:text-sa-fg",
            )}
          >
            {option.icon}
            {option.label}
            {option.count !== undefined && option.count > 0 && (
              <span className="sa-tabular text-[12px] font-normal text-sa-fg3" aria-label={`${option.count} open`}>
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---- Sheet ----

/**
 * A modal side sheet (settings on the right, history on the left). Focus is
 * trapped while it is open and returns to the opener on close; Escape and the
 * backdrop both close it.
 */
export function Sheet({
  open,
  onClose,
  title,
  side = "right",
  widthClass = "sm:max-w-[560px]",
  children,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  side?: "left" | "right";
  widthClass?: string;
  children: React.ReactNode;
  testId?: string;
}) {
  const ref = useFocusTrap<HTMLDivElement>(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex" data-testid={testId}>
      <div
        className="sa-fade absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-hidden
        data-testid={testId ? `${testId}-backdrop` : undefined}
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "relative flex h-full w-full flex-col border-sa-line bg-sa-panel shadow-2xl outline-none",
          widthClass,
          side === "right" ? "sa-sheet-right ml-auto sm:border-l" : "sa-sheet-left mr-auto sm:border-r",
        )}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-sa-line pl-4 pr-1.5">
          <h2 className="text-sm font-semibold text-sa-fg">{title}</h2>
          <IconButton label={`Close ${title.toLowerCase()}`} onClick={onClose}>
            <X className="h-4 w-4" aria-hidden />
          </IconButton>
        </div>
        <div className="sa-scroll min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

/** A centered spinner with a label, for a pane that is loading. */
export function Loading({ label, className }: { label: string; className?: string }) {
  return (
    <div role="status" className={cn("flex items-center justify-center gap-2 text-[13px] text-sa-fg2", className)}>
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

// ---- Split handle (resizable chat/stage split) ----

/** The chat column never goes below this width, so its content stays readable. */
export const SPLIT_CHAT_MIN_PX = 480;
/** The stage never goes below this width either; it shrinks first, never the chat. */
export const SPLIT_STAGE_MIN_PX = 480;
/** The flex gap between the two panes (the `gap-3` on the row). */
export const SPLIT_GAP_PX = 12;
/** The chat's default share of the row. */
export const SPLIT_RATIO_DEFAULT = 0.38;
/** Absolute sanity bounds for a stored ratio, whatever the viewport. */
export const SPLIT_RATIO_MIN = 0.2;
export const SPLIT_RATIO_MAX = 0.8;

/** Sanitize a stored split ratio to [0.2, 0.8]; anything unusable becomes the default. */
export function clampSplitRatio(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : SPLIT_RATIO_DEFAULT;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, n));
}

/**
 * The feasible ratio range for a row of this width, given the 480px floors
 * on both panes. When the row is too narrow for both floors the range is
 * degenerate and the split sits in the middle.
 */
export function splitRatioBounds(
  containerWidthPx: number,
  gapPx: number = SPLIT_GAP_PX,
): { min: number; max: number } {
  if (!Number.isFinite(containerWidthPx) || containerWidthPx <= SPLIT_CHAT_MIN_PX + SPLIT_STAGE_MIN_PX + gapPx) {
    return { min: 0.5, max: 0.5 };
  }
  return {
    min: Math.max(SPLIT_RATIO_MIN, SPLIT_CHAT_MIN_PX / containerWidthPx),
    max: Math.min(SPLIT_RATIO_MAX, (containerWidthPx - SPLIT_STAGE_MIN_PX - gapPx) / containerWidthPx),
  };
}

/** Clamp a ratio to the feasible range for a row of this width. */
export function clampSplitRatioForWidth(
  value: unknown,
  containerWidthPx: number,
  gapPx: number = SPLIT_GAP_PX,
): number {
  const { min, max } = splitRatioBounds(containerWidthPx, gapPx);
  const n = typeof value === "number" && Number.isFinite(value) ? value : SPLIT_RATIO_DEFAULT;
  return Math.min(max, Math.max(min, n));
}

/**
 * The chat column's width in px for a row of this width and ratio — the same
 * value the CSS clamp below resolves to. The chat floor wins when the row is
 * too narrow for both floors.
 */
export function splitChatWidthPx(
  containerWidthPx: number,
  ratio: number,
  gapPx: number = SPLIT_GAP_PX,
): number {
  const r = clampSplitRatioForWidth(ratio, containerWidthPx, gapPx);
  return Math.max(
    SPLIT_CHAT_MIN_PX,
    Math.min(containerWidthPx * r, containerWidthPx - SPLIT_STAGE_MIN_PX - gapPx),
  );
}

/** The chat column's width as a CSS clamp: 480px floor, ratio share, stage-keeps-480px ceiling. */
export function splitChatWidthCss(ratio: number): string {
  const pct = (clampSplitRatio(ratio) * 100).toFixed(1);
  return `clamp(${SPLIT_CHAT_MIN_PX}px, ${pct}%, calc(100% - ${SPLIT_STAGE_MIN_PX + SPLIT_GAP_PX}px))`;
}

export interface SplitHandleProps {
  /** Ref to the flex row that holds the two panes (measured for the ratio math). */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Ref to the chat column (measured at drag start so the divider follows the pointer). */
  chatRef: React.RefObject<HTMLElement | null>;
  /** Current chat share of the row, 0..1 (already sanitized). */
  ratio: number;
  /** Called with the new ratio, already clamped to the feasible range. */
  onRatioChange: (ratio: number) => void;
  testId?: string;
}

/**
 * The drag handle between the chat column and the stage. It takes no space
 * in the flex row (w-0): the grip floats over the gap, so adding it changes
 * no widths. Dragging moves the divider; arrow keys nudge it (Shift for a
 * bigger step), Home/End jump to the ends. Hidden below the wide breakpoint
 * — narrow screens stay a single pane.
 */
export function SplitHandle({ containerRef, chatRef, ratio, onRatioChange, testId }: SplitHandleProps) {
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ startX: number; startChatPx: number; contentWidth: number } | null>(null);

  const contentWidth = (): number => {
    const el = containerRef.current;
    if (!el || typeof window === "undefined") return 0;
    const rect = el.getBoundingClientRect();
    const style = typeof window.getComputedStyle === "function" ? window.getComputedStyle(el) : null;
    const pad =
      (style ? Number.parseFloat(style.paddingLeft || "0") + Number.parseFloat(style.paddingRight || "0") : 24) || 24;
    return Math.max(0, rect.width - pad);
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const width = contentWidth();
    const chatPx = chatRef.current?.getBoundingClientRect().width ?? 0;
    if (width <= 0 || chatPx <= 0) return;
    event.preventDefault();
    dragStart.current = { startX: event.clientX, startChatPx: chatPx, contentWidth: width };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const start = dragStart.current;
    if (!dragging || !start) return;
    const nextPx = start.startChatPx + (event.clientX - start.startX);
    onRatioChange(clampSplitRatioForWidth(nextPx / start.contentWidth, start.contentWidth));
  };

  const endDrag = (event: React.PointerEvent) => {
    if (!dragging) return;
    dragStart.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDragging(false);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const width = contentWidth();
    const { min, max } = width > 0 ? splitRatioBounds(width) : { min: SPLIT_RATIO_MIN, max: SPLIT_RATIO_MAX };
    const step = event.shiftKey ? 0.1 : 0.02;
    let next: number | undefined;
    if (event.key === "ArrowLeft") next = ratio - step;
    else if (event.key === "ArrowRight") next = ratio + step;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    if (next === undefined) return;
    event.preventDefault();
    onRatioChange(Math.min(max, Math.max(min, next)));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat and stage panels"
      aria-valuenow={Math.round(clampSplitRatio(ratio) * 100)}
      aria-valuemin={Math.round(SPLIT_RATIO_MIN * 100)}
      aria-valuemax={Math.round(SPLIT_RATIO_MAX * 100)}
      tabIndex={0}
      data-testid={testId ?? "split-handle"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      className={cn("group relative hidden w-0 shrink-0 cursor-col-resize self-stretch outline-none lg:flex")}
    >
      {/* Hit area: 12px wide, full height, centred on the gap. The grip floats over it. */}
      <div className="absolute inset-y-0 left-1/2 w-3 -translate-x-1/2 touch-none" aria-hidden>
        <div
          className={cn(
            "absolute left-1/2 top-1/2 h-16 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors",
            dragging ? "bg-sa-accent-fg opacity-100" : "bg-sa-line-strong opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-focus-visible:bg-sa-accent-fg",
          )}
        />
      </div>
    </div>
  );
}
