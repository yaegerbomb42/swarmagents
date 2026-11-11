/** Cockpit design tokens: CSS vars from styles/tokens.css with safe fallbacks. */

export const V = {
  bg0: 'var(--bg-0, #0a0a0c)',
  bg1: 'var(--bg-1, #111114)',
  bg2: 'var(--bg-2, #17171b)',
  bg3: 'var(--bg-3, #1f1f24)',
  line1: 'var(--line-1, rgba(255,255,255,0.06))',
  line2: 'var(--line-2, rgba(255,255,255,0.10))',
  line3: 'var(--line-3, rgba(255,255,255,0.16))',
  fg1: 'var(--fg-1, #f3f3f5)',
  fg2: 'var(--fg-2, #bdbdc1)',
  fg3: 'var(--fg-3, #8b8b92)',
  fg4: 'var(--fg-4, #626369)',
  accent: 'var(--accent, #56d9e7)',
  running: 'var(--st-running, #56d9e7)',
  done: 'var(--st-done, #5bd295)',
  failed: 'var(--st-failed, #f3625d)',
  blocked: 'var(--st-blocked, #f6b84d)',
  thinking: 'var(--st-thinking, #b199f4)',
  mono: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
} as const;

/** Hex fallbacks for <canvas>, which can't read CSS vars directly. */
export const CANVAS_FALLBACK: Record<string, string> = {
  '--bg-0': '#0a0a0c', '--bg-1': '#111114', '--line-1': 'rgba(255,255,255,0.06)',
  '--line-2': 'rgba(255,255,255,0.10)', '--fg-1': '#f3f3f5', '--fg-2': '#bdbdc1',
  '--fg-3': '#8b8b92', '--fg-4': '#626369', '--accent': '#56d9e7', '--st-failed': '#f3625d',
  '--st-done': '#5bd295', '--st-blocked': '#f6b84d', '--st-thinking': '#b199f4',
};

export function resolveVar(el: Element | null, name: string): string {
  if (el && typeof getComputedStyle === 'function') {
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    if (v) return v;
  }
  return CANVAS_FALLBACK[name] ?? '#888';
}

export function statusColor(status: string): string {
  switch (status) {
    case 'running': return V.running;
    case 'finished': return V.done;
    case 'paused': case 'queued': return V.blocked;
    case 'error': case 'stalled': case 'cancelled': return V.failed;
    case 'step_budget': case 'time_budget': case 'token_budget': case 'interrupted': return V.blocked;
    default: return V.fg3;
  }
}

export const numCls = 'font-mono tabular-nums';
