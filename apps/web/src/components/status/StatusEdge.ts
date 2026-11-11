import type { CSSProperties } from 'react';
import { statusEdgeStyle, type CanonicalStatus } from '@/lib/status';

export { statusEdgeStyle };

/**
 * React Flow / SVG helper: edge style keyed by the target node's status.
 * Returns props suitable for an SVG <path> plus an `animated` flag
 * (callers should also respect prefers-reduced-motion).
 */
export function statusEdgeProps(
  status: CanonicalStatus | string,
  opts: { reducedMotion?: boolean } = {},
): { style: CSSProperties; animated: boolean } {
  const s = statusEdgeStyle(status);
  return {
    style: {
      stroke: s.stroke,
      strokeWidth: s.strokeWidth,
      strokeDasharray: s.strokeDasharray,
      opacity: s.opacity,
    },
    animated: s.animated && !opts.reducedMotion,
  };
}
