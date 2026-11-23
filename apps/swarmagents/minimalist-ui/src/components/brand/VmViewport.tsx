"use client";

/**
 * VmViewport — the live VM screen frame.
 *
 * One stage, one chrome bar: status on the left (live dot + pill), controls
 * on the right (takeover, fullscreen). The screen content (canvas, video,
 * noVNC surface) is the caller's `children`; with no children the frame
 * shows an honest empty stage instead of fake pixels.
 *
 * Fullscreen uses the element's own requestFullscreen and tracks the
 * browser's fullscreenchange so the button state stays truthful.
 */

import React, { useEffect, useRef, useState } from "react";
import { cn } from "../../utils/cn";
import { Icon } from "./Icon";
import { StatusPill, type PillStatus } from "./StatusPill";
import { TakeoverButton, type Driver } from "./TakeoverButton";

/** Expand/collapse glyph — not in the brand icon set, drawn for this frame. */
function ExpandIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {expanded ? (
        <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
      ) : (
        <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
      )}
    </svg>
  );
}

export interface VmViewportProps {
  /** Screen content: canvas / video / remote-desktop surface. */
  children?: React.ReactNode;
  /** View label shown in the chrome bar, e.g. "Desktop", "Browser". */
  title?: string;
  status: PillStatus;
  statusLabel: string;
  /** Show the breathing live ring on the status dot. */
  live?: boolean;
  driver: Driver;
  onTakeover: () => void;
  onHandback: () => void;
  takeoverDisabled?: boolean;
  takeoverDisabledReason?: string;
  /** Extra controls rendered left of the takeover button. */
  controls?: React.ReactNode;
  /** Status strip under the stage (VM name, connection, freshness…). */
  footer?: React.ReactNode;
  /** Message for the empty stage when there is no stream yet. */
  emptyLabel?: string;
  aspectRatio?: string;
  className?: string;
}

export function VmViewport({
  children,
  title = "Desktop",
  status,
  statusLabel,
  live = false,
  driver,
  onTakeover,
  onHandback,
  takeoverDisabled = false,
  takeoverDisabledReason,
  controls,
  footer,
  emptyLabel = "No stream yet. Start a run and the computer appears here, live.",
  aspectRatio = "16 / 9",
  className,
}: VmViewportProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    function onChange() {
      setFullscreen(document.fullscreenElement === frameRef.current);
    }
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void frameRef.current?.requestFullscreen();
    }
  }

  return (
    <div
      ref={frameRef}
      className={cn(
        "flex flex-col overflow-hidden rounded-[var(--brand-radius-xl)] bg-[var(--brand-bg-deep)] shadow-[var(--brand-shadow-stage)]",
        className,
      )}
    >
      {/* Chrome bar */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--brand-hairline)] bg-[var(--brand-surface)] px-3">
        <span className="inline-flex items-center gap-2 text-[13px] font-medium text-[var(--brand-text)]">
          <Icon name="vm-screen" size={16} className="text-[var(--brand-text-2)]" />
          {title}
        </span>
        <StatusPill status={live && status !== "running" ? "running" : status}>{statusLabel}</StatusPill>
        <span className="flex-1" />
        {controls}
        <TakeoverButton
          driver={driver}
          onTakeover={onTakeover}
          onHandback={onHandback}
          disabled={takeoverDisabled}
          disabledReason={takeoverDisabledReason}
        />
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-label={fullscreen ? "Exit fullscreen" : "View fullscreen"}
          title={fullscreen ? "Exit fullscreen" : "View fullscreen"}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--brand-radius-md)] text-[var(--brand-text-2)] transition-colors hover:bg-[var(--brand-surface-hover)] hover:text-[var(--brand-text)] focus-visible:outline-none focus-visible:shadow-[var(--brand-focus-ring)]"
        >
          <ExpandIcon expanded={fullscreen} />
        </button>
      </div>

      {/* Stage */}
      <div
        className="relative w-full bg-black"
        style={{ aspectRatio: fullscreen ? undefined : aspectRatio, flex: fullscreen ? 1 : undefined }}
      >
        {children ?? (
          <div className="absolute inset-0 grid place-items-center px-6 text-center">
            <div>
              <Icon name="vm-screen" size={28} className="mx-auto text-[var(--brand-text-3)]" />
              <p className="mt-3 text-[13px] leading-relaxed text-[var(--brand-text-3)]">{emptyLabel}</p>
            </div>
          </div>
        )}
      </div>

      {footer ? (
        <div className="flex h-9 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--brand-hairline)] bg-[var(--brand-surface)] px-3 text-[11.5px] text-[var(--brand-text-2)]">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
