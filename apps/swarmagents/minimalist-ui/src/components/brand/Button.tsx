"use client";

/**
 * Buttons — the two actions the product needs.
 *
 * PrimaryButton is the one "you can act" fill: Signal Cyan with Ink text
 * (the mark's own pairing on dark). GhostButton is the quiet secondary:
 * transparent, Mist text, hairline on hover. Both are real <button>s with
 * visible focus rings, disabled states, and an optional loading state that
 * blocks clicks while an action is in flight.
 */

import React from "react";
import { cn } from "../../utils/cn";

export type ButtonSize = "sm" | "md" | "lg";

const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px] rounded-[var(--brand-radius-md)]",
  md: "h-9 px-3.5 text-sm rounded-[var(--brand-radius-md)]",
  lg: "h-11 px-5 text-[15px] rounded-[var(--brand-radius-lg)]",
};

const BASE =
  "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap font-medium " +
  "transition-[background-color,border-color,color,transform] duration-[var(--brand-motion-fast)] " +
  "focus-visible:outline-none focus-visible:shadow-[var(--brand-focus-ring)] " +
  "active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100";

export interface BrandButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: ButtonSize;
  /** Shows a spinner and blocks clicks while an action is in flight. */
  loading?: boolean;
}

function Spinner({ className }: { className?: string }) {
  return <span aria-hidden className={cn("brand-spinner h-3.5 w-3.5 shrink-0", className)} />;
}

export const PrimaryButton = React.forwardRef<HTMLButtonElement, BrandButtonProps>(
  function PrimaryButton(
    { size = "md", loading = false, className, children, disabled, type, ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={cn(
          BASE,
          SIZE[size],
          "bg-[var(--brand-signal)] text-[var(--brand-text-on-signal)] shadow-[var(--brand-shadow-card)]",
          "hover:bg-[#33dbf5] disabled:hover:bg-[var(--brand-signal)]",
          className,
        )}
        {...rest}
      >
        {loading ? <Spinner /> : null}
        {children}
      </button>
    );
  },
);

export const GhostButton = React.forwardRef<HTMLButtonElement, BrandButtonProps>(
  function GhostButton(
    { size = "md", loading = false, className, children, disabled, type, ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={cn(
          BASE,
          SIZE[size],
          "border border-transparent text-[var(--brand-text-2)]",
          "hover:border-[var(--brand-hairline-strong)] hover:bg-[var(--brand-surface-hover)] hover:text-[var(--brand-text)]",
          className,
        )}
        {...rest}
      >
        {loading ? <Spinner /> : null}
        {children}
      </button>
    );
  },
);
