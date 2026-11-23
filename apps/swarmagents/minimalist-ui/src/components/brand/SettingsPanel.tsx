"use client";

/**
 * SettingsPanel — the top-right panel shell.
 *
 * A slide-over anchored to the right edge (the confirmed settings pattern:
 * input bar at the bottom, live screen in the middle, settings top-right).
 * This is only the shell — header, scrollable body, optional pinned footer;
 * the settings themselves are the caller's children.
 *
 * Keyboard: Esc closes, focus moves into the panel on open and returns to
 * the opener on close. Scrim click closes. role="dialog" aria-modal.
 */

import React, { useEffect, useRef } from "react";
import { cn } from "../../utils/cn";
import { Icon } from "./Icon";

/** Close glyph — not in the brand icon set, drawn for this shell. */
function CloseIcon() {
  return (
    <svg
      width={15}
      height={15}
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

export interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  /** Pinned footer (save state, policy line…). */
  footer?: React.ReactNode;
  className?: string;
}

export function SettingsPanel({
  open,
  onClose,
  title = "Settings",
  children,
  footer,
  className,
}: SettingsPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    closeRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (openerRef.current instanceof HTMLElement) openerRef.current.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0" style={{ zIndex: 60 /* --brand-z-panel */ }}>
      <button
        type="button"
        aria-label="Close settings"
        onClick={onClose}
        className="brand-scrim-in absolute inset-0 h-full w-full cursor-default bg-[rgba(4,6,12,0.55)] backdrop-blur-[2px]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "brand-panel-in absolute right-0 top-0 flex h-full w-[min(380px,92vw)] flex-col border-l border-[var(--brand-hairline-strong)] bg-[var(--brand-surface-raised)] shadow-[var(--brand-shadow-pop)]",
          className,
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--brand-hairline)] px-4">
          <Icon name="settings" size={17} className="text-[var(--brand-signal)]" />
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--brand-text)]">{title}</h2>
          <span className="flex-1" />
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="grid h-8 w-8 place-items-center rounded-[var(--brand-radius-md)] text-[var(--brand-text-2)] transition-colors hover:bg-[var(--brand-surface-hover)] hover:text-[var(--brand-text)] focus-visible:outline-none focus-visible:shadow-[var(--brand-focus-ring)]"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer ? (
          <div className="shrink-0 border-t border-[var(--brand-hairline)] px-4 py-3 text-[11.5px] text-[var(--brand-text-3)]">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
