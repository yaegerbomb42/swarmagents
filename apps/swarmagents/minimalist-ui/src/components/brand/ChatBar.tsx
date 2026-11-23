"use client";

/**
 * ChatBar — the one chat bar. Describe the task, press Enter, the agent runs.
 *
 *  - Auto-growing textarea (1 → 6 rows), Enter runs, Shift+Enter newlines.
 *  - While a run is live the send button becomes Stop (same slot, same size,
 *    so the bar never jumps).
 *  - Attach is optional; when the deployment can't honour a run, pass
 *    `disabledReason` and the bar refuses with the reason visible — the
 *    capability-gating rule from design/capabilities.ts, applied to the
 *    product's front door.
 *  - Drag-over state via `dragging` (wire to your drop handler).
 */

import React, { useEffect, useRef } from "react";
import { cn } from "../../utils/cn";
import { Icon } from "./Icon";

export interface ChatBarProps {
  value: string;
  onChange: (value: string) => void;
  /** Called with the trimmed task when the user runs it. */
  onSubmit: (task: string) => void;
  /** Called when Stop is pressed mid-run. Omit to hide the stop state. */
  onStop?: () => void;
  /** A run is live: send becomes stop, input stays editable for steering. */
  running?: boolean;
  /** Attach handler; omit to hide the attach button. */
  onAttach?: () => void;
  attachLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Why the bar is disabled — rendered under the bar, never silent. */
  disabledReason?: string;
  /** Drop-target highlight while files are dragged over the bar. */
  dragging?: boolean;
  autoFocus?: boolean;
  className?: string;
}

const MAX_ROWS = 6;

export function ChatBar({
  value,
  onChange,
  onSubmit,
  onStop,
  running = false,
  onAttach,
  attachLabel = "Attach a file",
  placeholder = "Describe the task. The agent has its own computer.",
  disabled = false,
  disabledReason,
  dragging = false,
  autoFocus = false,
  className,
}: ChatBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow: height follows content up to MAX_ROWS, then scrolls.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = 22;
    const max = lineHeight * MAX_ROWS + 16;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [value]);

  const canSubmit = !disabled && !running && value.trim().length > 0;
  const showStop = running && onStop !== undefined;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (showStop) {
      onStop?.();
      return;
    }
    if (canSubmit) onSubmit(value.trim());
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSubmit) onSubmit(value.trim());
    }
  }

  return (
    <div className={className}>
      <form
        onSubmit={handleSubmit}
        className={cn(
          "brand-chatbar flex items-end gap-2 rounded-[var(--brand-radius-xl)] border border-[var(--brand-hairline-strong)] bg-[var(--brand-surface-raised)] p-2 shadow-[var(--brand-shadow-pop)]",
          dragging && "brand-chatbar--drag",
          disabled && "opacity-60",
        )}
      >
        {onAttach ? (
          <button
            type="button"
            onClick={onAttach}
            disabled={disabled}
            aria-label={attachLabel}
            title={attachLabel}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--brand-radius-md)] text-[var(--brand-text-2)] transition-colors hover:bg-[var(--brand-surface-hover)] hover:text-[var(--brand-text)] focus-visible:outline-none focus-visible:shadow-[var(--brand-focus-ring)] disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Icon name="file" size={18} />
          </button>
        ) : null}

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          rows={1}
          aria-label="Describe the task"
          className="min-h-9 flex-1 resize-none bg-transparent px-1 py-[7px] text-[15px] leading-[22px] text-[var(--brand-text)] outline-none placeholder:text-[var(--brand-text-3)] disabled:cursor-not-allowed"
        />

        <button
          type="submit"
          disabled={showStop ? disabled : !canSubmit}
          aria-label={showStop ? "Stop the run" : "Run the task"}
          title={showStop ? "Stop the run" : "Run the task (Enter)"}
          className={cn(
            "grid h-9 w-9 shrink-0 place-items-center rounded-[var(--brand-radius-md)] transition-[background-color,transform] duration-[var(--brand-motion-fast)] focus-visible:outline-none focus-visible:shadow-[var(--brand-focus-ring)] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100",
            showStop
              ? "border border-[rgba(251,113,133,0.45)] bg-[rgba(251,113,133,0.12)] text-[var(--brand-err)] hover:bg-[rgba(251,113,133,0.2)]"
              : "bg-[var(--brand-signal)] text-[var(--brand-text-on-signal)] hover:bg-[#33dbf5]",
          )}
        >
          <Icon name={showStop ? "stop" : "play"} size={17} />
        </button>
      </form>

      <div className="mt-2 flex items-center justify-between px-1 text-[11px] leading-none text-[var(--brand-text-3)]">
        <span aria-live="polite">
          {disabled && disabledReason
            ? disabledReason
            : running
              ? "Running. Type to steer, or stop the run."
              : "Enter to run · Shift+Enter for a new line"}
        </span>
        <span className="hidden items-center gap-1.5 sm:inline-flex">
          <Icon name="shield" size={12} />
          Runs in your own VM
        </span>
      </div>
    </div>
  );
}
