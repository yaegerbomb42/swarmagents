"use client";

// Small inline icon set used across the swarm UI. Kept local so components
// don't depend on a full icon library for the few glyphs they need.
import type { SVGProps } from "react";

/** Close × icon (lucide-style stroke). */
export function IX(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export default IX;
