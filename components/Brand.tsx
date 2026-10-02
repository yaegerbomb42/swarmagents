"use client";

import { cssVars } from "@/lib/design-tokens";

/**
 * Brand marks as inline SVG components.
 * Source assets: public/brand/main-icon-source.jpg (hexagon), settings-icon-source.jpg (wrench), logo-source.jpg (wordmark)
 * These are clean, traced SVG versions — no external image dependencies.
 */

// Glowing white hexagon — the main brand mark
export function HexagonMark({
  className = "",
  size = 48,
  state = "idle", // "idle" | "thinking" | "working" | "error"
  ariaLabel = "SwarmAgents",
}: {
  className?: string;
  size?: number;
  state?: "idle" | "thinking" | "working" | "error";
  ariaLabel?: string;
}) {
  const stateClass = state !== "idle" ? state : "";
  return (
    <svg
      className={`hexagon ${stateClass} ${className}`}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      role="img"
      aria-label={ariaLabel}
      style={{
        filter: `drop-shadow(0 0 4px var(${cssVars.neonStrong})) drop-shadow(0 0 8px var(${cssVars.neonMed}))`,
      }}
    >
      <path
        d="M24 3 L42.78 12.9 V35.1 L24 45 L5.22 35.1 V12.9 L24 3 Z"
        stroke="var(--color-neon)"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Inner subtle hexagon for depth */}
      <path
        d="M24 8 L36.5 15.5 V32.5 L24 40 L11.5 32.5 V15.5 L24 8 Z"
        stroke="var(--color-neon)"
        strokeWidth="0.5"
        fill="none"
        opacity="0.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Wrench icon — for Settings (thicker at small sizes for visibility next to other sidebar icons)
export function WrenchMark({
  className = "",
  size = 20,
  ariaLabel = "Settings",
}: {
  className?: string;
  size?: number;
  ariaLabel?: string;
}) {
  // Use thicker stroke at 16px and below
  const strokeWidth = size <= 16 ? 2.5 : 2;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      role="img"
      aria-label={ariaLabel}
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      <line x1="22" y1="22" x2="15.5" y2="15.5" />
    </svg>
  );
}

// SwarmAgents.codes wordmark
export function Wordmark({
  className = "",
  width = 200,
  ariaLabel = "SwarmAgents.codes",
}: {
  className?: string;
  width?: number;
  ariaLabel?: string;
}) {
  return (
    <svg
      className={className}
      width={width}
      height={(width * 56) / 356}
      viewBox="0 0 356 56"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      role="img"
      aria-label={ariaLabel}
    >
      <text
        x="0"
        y="42"
        fontFamily="var(--font-sans)"
        fontSize="42"
        fontWeight="600"
        fill="var(--color-neon)"
        letterSpacing="-0.02em"
        textLength={262}
        lengthAdjust="spacingAndGlyphs"
        style={{
          filter: "drop-shadow(0 0 4px var(--color-neon-strong)) drop-shadow(0 0 8px var(--color-neon-med))",
        }}
      >
        SwarmAgents
      </text>
      <text
        x="270"
        y="42"
        fontFamily="var(--font-mono)"
        fontSize="22"
        fontWeight="500"
        fill="var(--color-text-muted)"
        letterSpacing="0.02em"
        textLength={84}
        lengthAdjust="spacingAndGlyphs"
      >
        .codes
      </text>
    </svg>
  );
}

// Small inline hexagon for header/empty state
export function MiniHexagon({
  className = "",
  size = 24,
  state = "idle",
}: {
  className?: string;
  size?: number;
  state?: "idle" | "thinking" | "working" | "error";
}) {
  const stateClass = state !== "idle" ? state : "";
  return (
    <svg
      className={`hexagon ${stateClass} ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M12 1.5 L21.6 7.5 V16.5 L12 22.5 L2.4 16.5 V7.5 L12 1.5 Z"
        stroke="var(--color-neon)"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
