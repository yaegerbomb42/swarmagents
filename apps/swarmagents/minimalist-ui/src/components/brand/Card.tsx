"use client";

/**
 * Card — the raised surface everything sits on: Void lifted one step,
 * hairline border, 1px top light. `interactive` adds hover lift for cards
 * that are themselves controls (pair with a real <button> or role).
 */

import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../utils/cn";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** Hover affordance for clickable cards. */
  interactive?: boolean;
  /** Remove default padding (for cards that manage their own insets). */
  flush?: boolean;
}

export function Card({ children, interactive = false, flush = false, className, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-[var(--brand-radius-lg)] border border-[var(--brand-hairline)] bg-[var(--brand-surface)] shadow-[var(--brand-shadow-card)]",
        flush ? "" : "p-4",
        interactive &&
          "transition-[background-color,border-color] duration-[var(--brand-motion-fast)] hover:border-[var(--brand-hairline-strong)] hover:bg-[var(--brand-surface-raised)]",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
