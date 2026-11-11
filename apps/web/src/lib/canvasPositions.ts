export const CANVAS_W = 800;
export const CANVAS_H = 420;

/** Deterministic canvas coordinates for SwarmCanvas live position sync. */
export function computeAgentCanvasPosition(
  index: number,
  total: number,
  status: string,
): { x: number; y: number } {
  const golden = index * 2.399963;
  const spread = 0.35 + (index % 7) * 0.09;
  const r = 0.22 * Math.min(CANVAS_W, CANVAS_H) * spread;
  const cx = CANVAS_W * 0.5;
  const cy = CANVAS_H * 0.5;
  let x = cx + Math.cos(golden) * r;
  let y = cy + Math.sin(golden) * r;
  // Active agents cluster toward mission center; idle agents drift outward.
  const active = status === 'running' || status === 'executing' || status === 'assigned';
  const pull = active ? 0.82 : 1.08 + (index % 3) * 0.04;
  x = cx + (x - cx) * pull;
  y = cy + (y - cy) * pull;
  return {
    x: Math.max(28, Math.min(CANVAS_W - 28, Math.round(x))),
    y: Math.max(28, Math.min(CANVAS_H - 28, Math.round(y))),
  };
}
