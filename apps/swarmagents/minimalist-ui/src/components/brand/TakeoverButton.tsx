"use client";

/**
 * TakeoverButton — the one-click grab of the controls, and the hand-back.
 *
 * Two states, one slot: while the agent drives it offers "Take over"; while
 * the human drives it offers "Hand back" and reads as active (Signal fill),
 * so the current driver is never ambiguous. Disabled carries its reason in
 * the title — a dead control with no explanation is a dead end.
 */

import { cn } from "../../utils/cn";
import { Icon } from "./Icon";

export type Driver = "agent" | "human";

export interface TakeoverButtonProps {
  driver: Driver;
  onTakeover: () => void;
  onHandback: () => void;
  disabled?: boolean;
  disabledReason?: string;
  testId?: string;
  className?: string;
}

export function TakeoverButton({
  driver,
  onTakeover,
  onHandback,
  disabled = false,
  disabledReason,
  testId,
  className,
}: TakeoverButtonProps) {
  const humanDriving = driver === "human";
  return (
    <button
      type="button"
      onClick={humanDriving ? onHandback : onTakeover}
      disabled={disabled}
      data-testid={testId}
      aria-pressed={humanDriving}
      aria-label={humanDriving ? "Hand control back to the agent" : "Take over control of the computer"}
      title={disabled ? disabledReason : humanDriving ? "Hand control back to the agent" : "Take over control"}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--brand-radius-md)] px-2.5 text-[12.5px] font-medium transition-[background-color,border-color,color] duration-[var(--brand-motion-fast)] focus-visible:outline-none focus-visible:shadow-[var(--brand-focus-ring)] disabled:cursor-not-allowed disabled:opacity-45",
        humanDriving
          ? "bg-[var(--brand-signal)] text-[var(--brand-text-on-signal)] hover:bg-[#33dbf5]"
          : "border border-[var(--brand-hairline-strong)] bg-[rgba(255,255,255,0.04)] text-[var(--brand-text)] hover:bg-[var(--brand-surface-hover)]",
        className,
      )}
    >
      <Icon name={humanDriving ? "play" : "takeover"} size={15} />
      {humanDriving ? "Hand back" : "Take over"}
    </button>
  );
}
