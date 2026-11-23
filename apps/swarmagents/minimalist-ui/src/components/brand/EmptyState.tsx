"use client";

/**
 * EmptyState — an empty surface that teaches the next action.
 *
 * Brand version of the design/ EmptyState: same ringed-tile art idea, but
 * the tile carries a brand icon and the action row is starter-task chips —
 * one click fills the chat bar with a real first task instead of leaving
 * the user staring at a blank prompt.
 */

import type { ReactNode } from "react";
import { cn } from "../../utils/cn";
import { Icon } from "./Icon";
import type { IconName } from "./tokens";

export interface StarterTask {
  label: string;
  /** The full task text handed to onStarterSelect (defaults to label). */
  task?: string;
}

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  description?: ReactNode;
  starters?: readonly StarterTask[];
  onStarterSelect?: (task: string) => void;
  /** Extra action under the chips (e.g. a PrimaryButton). */
  action?: ReactNode;
  className?: string;
  /** Test id on the root element (lets callers keep their assertions). */
  testId?: string;
  /** Test id applied to every starter chip. */
  starterTestId?: string;
}

export function EmptyState({
  icon = "chat-bar",
  title,
  description,
  starters,
  onStarterSelect,
  action,
  className,
  testId,
  starterTestId,
}: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center px-4 py-10 text-center", className)} data-testid={testId}>
      <div className="relative mb-5 grid h-[72px] w-[72px] place-items-center rounded-[var(--brand-radius-xl)] border border-[var(--brand-hairline-strong)] bg-[var(--brand-surface)] text-[var(--brand-signal)] shadow-[var(--brand-shadow-card)]">
        <span
          aria-hidden
          className="absolute inset-0 rounded-[var(--brand-radius-xl)] shadow-[0_0_0_10px_rgba(0,208,240,0.04)]"
        />
        <Icon name={icon} size={26} />
      </div>
      <h3 className="text-[17px] font-semibold tracking-[-0.02em] text-[var(--brand-text)]">{title}</h3>
      {description ? (
        <div className="mt-2 max-w-[340px] text-[13px] leading-relaxed text-[var(--brand-text-2)]">
          {description}
        </div>
      ) : null}
      {starters && starters.length > 0 ? (
        <div className="mt-5 flex max-w-[520px] flex-wrap items-center justify-center gap-2">
          {starters.map((starter) => (
            <button
              key={starter.label}
              type="button"
              data-testid={starterTestId}
              onClick={() => onStarterSelect?.(starter.task ?? starter.label)}
              className="rounded-[var(--brand-radius-full)] border border-[var(--brand-hairline-strong)] bg-[var(--brand-surface)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--brand-text-2)] transition-[background-color,color,border-color] duration-[var(--brand-motion-fast)] hover:border-[rgba(0,208,240,0.45)] hover:bg-[var(--brand-surface-hover)] hover:text-[var(--brand-text)] focus-visible:outline-none focus-visible:shadow-[var(--brand-focus-ring)]"
            >
              {starter.label}
            </button>
          ))}
        </div>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
