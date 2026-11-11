/**
 * Shared time-budget parsing, scaling targets, and fit scoring
 * for hierarchical task decomposition.
 * Supports 20 seconds to 100 days.
 */

export type FitStatus = 'under' | 'fit' | 'over' | 'unknown';

export interface BudgetTargets {
  /** Parsed wall-clock budget in minutes */
  budgetMinutes: number;
  /** Human label e.g. "1 hour" */
  label: string;
  /** Ideal leaf count for this budget */
  targetLeaves: number;
  /** Soft max leaves (hard stop for auto-deepen) */
  maxLeaves: number;
  /** Max recursion depth for auto-deepen */
  maxDepth: number;
  /** Leaf effort that still needs deepening (minutes) */
  deepenAboveMinutes: number;
  /** Ideal atomic leaf size (minutes) */
  targetLeafMinutes: number;
  /** Suggested top-level area count */
  topLevelAreas: { min: number; max: number };
  /** Suggested children per area on first pass */
  childrenPerArea: { min: number; max: number };
}

export interface FitMeter {
  status: FitStatus;
  budgetMinutes: number;
  estimatedMinutes: number;
  ratio: number;
  leafCount: number;
  targetLeaves: number;
  label: string;
  message: string;
}

const MINUTE = 1;
const HOUR = 60;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MAX_DAYS = 100;

/**
 * Convert budget in minutes → a scale label suitable for API / display.
 * Uses adaptive units: seconds up to 60s, minutes up to 2h, hours up to 2d, then days.
 */
export function formatBudget(budgetMinutes: number): string {
  if (!Number.isFinite(budgetMinutes) || budgetMinutes <= 0) return '0s';
  const totalSeconds = Math.round(budgetMinutes * 60);
  if (totalSeconds < 120) return `${totalSeconds}s`;
  if (budgetMinutes < 120) return `${Math.round(budgetMinutes)}m`;
  if (budgetMinutes < 48 * HOUR) return `${(budgetMinutes / HOUR).toFixed(1)}h`;
  return `${(budgetMinutes / DAY).toFixed(1)}d`;
}

/** Parse free-form time strings / numbers into minutes. */
export function parseTimeToMinutes(input: string | number | null | undefined): number {
  if (input == null || input === '') return 3 * HOUR; // default 3h

  // Canonical: numeric inputs are already minutes (TimeBudgetControl / API).
  if (typeof input === 'number' && Number.isFinite(input)) {
    return Math.max(1 / 3, Math.round(input * 100) / 100);
  }

  const raw = String(input).trim().toLowerCase();
  if (!raw || raw === 'open-ended' || raw === 'open' || raw === 'unlimited') {
    return MAX_DAYS * DAY; // treat open-ended as max horizon
  }

  // Compound: "1d 4h", "2h 30m", "45s", "20s"
  const compound = raw.match(
    /(?:(\d+(?:\.\d+)?)\s*w(?:eeks?)?)?\s*(?:(\d+(?:\.\d+)?)\s*d(?:ays?)?)?\s*(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?)?/
  );
  if (compound && (compound[1] || compound[2] || compound[3] || compound[4] || compound[5])) {
    const w = parseFloat(compound[1] || '0');
    const d = parseFloat(compound[2] || '0');
    const h = parseFloat(compound[3] || '0');
    const m = parseFloat(compound[4] || '0');
    const s = parseFloat(compound[5] || '0');
    const total = w * WEEK + d * DAY + h * HOUR + m + s / 60;
    if (total > 0) return Math.max(1 / 3, Math.round(total * 100) / 100); // minimum 20s
  }

  const num = parseFloat(raw);
  if (!Number.isFinite(num) || num <= 0) return 3 * HOUR;

  if (/\bweeks?\b|\bw\b/.test(raw)) return Math.min(MAX_DAYS * DAY, Math.round(num * WEEK));
  if (/\bdays?\b|\bd\b/.test(raw)) return Math.min(MAX_DAYS * DAY, Math.round(num * DAY));
  if (/\bhours?\b|\bhrs?\b|\bh\b/.test(raw)) return Math.round(num * HOUR);
  if (/\bmin(?:ute)?s?\b|\bm\b/.test(raw)) return Math.max(1 / 3, Math.round(num || 1));
  if (/\bsec(?:ond)?s?\b|\bs\b/.test(raw)) return Math.max(1 / 3, num / 60);
  // Bare number with no unit → minutes (matches TimeBudgetControl canonical unit)
  return Math.max(1 / 3, Math.round(num));
}

export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0s';
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  if (minutes < HOUR) return `${Math.round(minutes)}m`;
  if (minutes < DAY) {
    const h = minutes / HOUR;
    return h % 1 === 0 ? `${h}h` : `${h.toFixed(1)}h`;
  }
  if (minutes < WEEK) {
    const d = minutes / DAY;
    return d % 1 === 0 ? `${d}d` : `${d.toFixed(1)}d`;
  }
  const w = minutes / WEEK;
  return w % 1 === 0 ? `${w}w` : `${w.toFixed(1)}w`;
}

/** Scale decomposition fan-out to the user's wall-clock budget. */
export function computeBudgetTargets(budgetMinutes: number): BudgetTargets {
  // Clamp inputs from 20 seconds to 100 days
  const m = Math.max(1 / 3, Math.min(MAX_DAYS * DAY, Number(budgetMinutes) || 180));
  const label = formatMinutes(m);

  // Short budgets: mild serial pad (×1.5). Longer: ×3 for retries/validation.
  const serialPad = m <= 15 ? 1.5 : m <= 60 ? 2 : 3;
  const serialTarget = m * serialPad;

  let targetLeafMinutes: number;
  let deepenAboveMinutes: number;
  let maxDepth: number;
  let topLevelAreas: { min: number; max: number };
  let childrenPerArea: { min: number; max: number };
  let hardMaxLeaves: number | null = null;

  if (m <= 1) {
    // ≤1 min: 1–2 chunky leaves, no micro-splitting
    targetLeafMinutes = 1;
    deepenAboveMinutes = 2;
    maxDepth = 1;
    topLevelAreas = { min: 1, max: 1 };
    childrenPerArea = { min: 1, max: 2 };
    hardMaxLeaves = 3;
  } else if (m <= 5) {
    // 5 min: a handful of real tasks, not 50 micro-leaves
    targetLeafMinutes = 2;
    deepenAboveMinutes = 4;
    maxDepth = 2;
    topLevelAreas = { min: 1, max: 2 };
    childrenPerArea = { min: 1, max: 3 };
    hardMaxLeaves = 8;
  } else if (m <= 15) {
    targetLeafMinutes = 3;
    deepenAboveMinutes = 6;
    maxDepth = 2;
    topLevelAreas = { min: 2, max: 3 };
    childrenPerArea = { min: 2, max: 3 };
    hardMaxLeaves = 14;
  } else if (m <= 30) {
    targetLeafMinutes = 4;
    deepenAboveMinutes = 8;
    maxDepth = 3;
    topLevelAreas = { min: 2, max: 3 };
    childrenPerArea = { min: 2, max: 4 };
    hardMaxLeaves = 24;
  } else if (m <= 60) {
    targetLeafMinutes = 5;
    deepenAboveMinutes = 10;
    maxDepth = 4;
    topLevelAreas = { min: 3, max: 5 };
    childrenPerArea = { min: 2, max: 4 };
    hardMaxLeaves = 40;
  } else if (m <= 180) {
    targetLeafMinutes = 5;
    deepenAboveMinutes = 12;
    maxDepth = 5;
    topLevelAreas = { min: 4, max: 7 };
    childrenPerArea = { min: 3, max: 5 };
  } else if (m <= DAY) {
    targetLeafMinutes = 6;
    deepenAboveMinutes = 14;
    maxDepth = 6;
    topLevelAreas = { min: 5, max: 8 };
    childrenPerArea = { min: 3, max: 5 };
  } else if (m <= 7 * DAY) {
    targetLeafMinutes = 8;
    deepenAboveMinutes = 16;
    maxDepth = 7;
    topLevelAreas = { min: 6, max: 10 };
    childrenPerArea = { min: 3, max: 6 };
  } else if (m <= 30 * DAY) {
    targetLeafMinutes = 10;
    deepenAboveMinutes = 20;
    maxDepth = 8;
    topLevelAreas = { min: 8, max: 14 };
    childrenPerArea = { min: 4, max: 7 };
  } else {
    targetLeafMinutes = 12;
    deepenAboveMinutes = 24;
    maxDepth = 9;
    topLevelAreas = { min: 10, max: 16 };
    childrenPerArea = { min: 4, max: 8 };
  }

  const rawLeaves = Math.round(serialTarget / Math.max(0.5, targetLeafMinutes));
  const minLeaves = m <= 5 ? 2 : m <= 15 ? 3 : 4;
  let targetLeaves = Math.max(minLeaves, Math.min(2000, rawLeaves));
  if (hardMaxLeaves != null) {
    targetLeaves = Math.min(targetLeaves, hardMaxLeaves);
  }
  const maxLeaves =
    hardMaxLeaves != null
      ? hardMaxLeaves
      : Math.min(3000, Math.round(targetLeaves * 1.4));

  return {
    budgetMinutes: m,
    label,
    targetLeaves,
    maxLeaves,
    maxDepth,
    deepenAboveMinutes,
    targetLeafMinutes,
    topLevelAreas,
    childrenPerArea,
  };
}

export function expectedLeavesHint(budgetMinutes: number): string {
  const t = computeBudgetTargets(budgetMinutes);
  if (t.budgetMinutes <= 15) {
    return `~${t.targetLeaves} tasks · ~${t.targetLeafMinutes}m each`;
  }
  return `~${t.targetLeaves} tasks · ${t.targetLeafMinutes}m each`;
}

/** Walk a nested node tree and sum leaf effort + count. */
export function summarizeTreeEffort(nodes: any[]): {
  leafCount: number;
  estimatedMinutes: number;
  needsDeeper: number;
} {
  let leafCount = 0;
  let estimatedMinutes = 0;
  let needsDeeper = 0;

  const walk = (list: any[]) => {
    for (const n of list || []) {
      const kids = n.children || n.subtasks;
      if (kids && kids.length > 0) {
        walk(kids);
      } else {
        leafCount++;
        const effort = Number(n.effort_minutes ?? n.estimated_duration ?? 10) || 10;
        estimatedMinutes += effort;
        if (n.needs_deeper) needsDeeper++;
      }
    }
  };
  walk(nodes);
  return { leafCount, estimatedMinutes, needsDeeper };
}

export type AgentClass =
  | 'architect'
  | 'implementer'
  | 'researcher'
  | 'verifier'
  | 'debugger'
  | 'browser-agent'
  | 'security-auditor'
  | 'documentation-writer'
  | 'devops-engineer'
  | 'data-analyst'
  | 'product-manager'
  | 'ux-critic'
  | 'performance-optimizer'
  | 'dependency-manager'
  | 'merge-resolver'
  | 'test-writer'
  | 'code-migrator'
  | 'release-engineer'
  | 'qa-engineer'
  | 'orchestrator';

export type ToolKind = 'shell' | 'browser' | 'edit' | 'test' | 'search';

export interface TreeSummary {
  leafCount: number;
  areaCount: number;
  estimatedMinutes: number;
  criticalPathMinutes: number;
  parallelWidth: number;
  byAgentClass: Record<string, number>;
  byTool: Record<string, number>;
  /** Rough $ assuming grunt local=$0, cloud specialist ~$0.02/leaf */
  costEstimateUsd: number;
  needsDeeper: number;
  withAcceptance: number;
  withDeps: number;
}

function flattenLeaves(nodes: any[]): any[] {
  const leaves: any[] = [];
  const walk = (list: any[]) => {
    for (const n of list || []) {
      const kids = n.children || n.subtasks;
      if (kids && kids.length > 0) walk(kids);
      else leaves.push(n);
    }
  };
  walk(nodes);
  return leaves;
}

function countAreas(nodes: any[]): number {
  let n = 0;
  const walk = (list: any[]) => {
    for (const node of list || []) {
      if (node.children?.length || node.type === 'area') n++;
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return n;
}

/** Longest dependency chain (effort) among leaves + parent nesting. */
export function criticalPathMinutes(nodes: any[]): number {
  const leaves = flattenLeaves(nodes);
  const byId = new Map<string, any>();
  const indexAll = (list: any[]) => {
    for (const n of list || []) {
      byId.set(n.id, n);
      if (n.children) indexAll(n.children);
    }
  };
  indexAll(nodes);

  const memo = new Map<string, number>();
  const dfs = (id: string, stack: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (stack.has(id)) return 0;
    const node = byId.get(id);
    if (!node) return 0;
    stack.add(id);
    const effort = Number(node.effort_minutes ?? 0) || 0;
    const deps: string[] = node.depends_on || [];
    let pred = 0;
    for (const d of deps) pred = Math.max(pred, dfs(d, stack));
    // Also consider parent chain as soft predecessor
    if (node.parentId && byId.has(node.parentId)) {
      const parent = byId.get(node.parentId);
      if (parent && !(parent.children?.length)) {
        pred = Math.max(pred, dfs(node.parentId, stack));
      }
    }
    stack.delete(id);
    const total = effort + pred;
    memo.set(id, total);
    return total;
  };

  let best = 0;
  for (const leaf of leaves) {
    best = Math.max(best, dfs(leaf.id, new Set()));
  }
  // Fallback: deepest nesting sum if no deps
  if (best === 0) {
    const depthSum = (list: any[], acc: number): number => {
      let m = acc;
      for (const n of list || []) {
        const e = Number(n.effort_minutes ?? 0) || 0;
        if (n.children?.length) m = Math.max(m, depthSum(n.children, acc + e));
        else m = Math.max(m, acc + e);
      }
      return m;
    };
    best = depthSum(nodes, 0);
  }
  return best;
}

/** Max number of leaves with no mutual depends_on (approx ready-set size). */
export function parallelWidth(nodes: any[]): number {
  const leaves = flattenLeaves(nodes);
  if (!leaves.length) return 0;
  const roots = leaves.filter((l) => !(l.depends_on || []).length);
  // Heuristic: max(ready roots, ceil(leaves/critical-path-slots))
  const cp = Math.max(1, criticalPathMinutes(nodes));
  const serial = leaves.reduce((s, l) => s + (Number(l.effort_minutes) || 2), 0);
  const fromCp = Math.max(1, Math.round(serial / cp));
  return Math.max(roots.length || 1, Math.min(leaves.length, fromCp));
}

export function computeTreeSummary(nodes: any[]): TreeSummary {
  const { leafCount, estimatedMinutes, needsDeeper } = summarizeTreeEffort(nodes);
  const leaves = flattenLeaves(nodes);
  const byAgentClass: Record<string, number> = {};
  const byTool: Record<string, number> = {};
  let withAcceptance = 0;
  let withDeps = 0;
  let cloudLeaves = 0;

  for (const l of leaves) {
    const cls = l.agent_class || l.model_tier || 'implementer';
    byAgentClass[cls] = (byAgentClass[cls] || 0) + 1;
    if (cls !== 'implementer') cloudLeaves++;
    const tools: string[] = l.tools || [];
    for (const t of tools) byTool[t] = (byTool[t] || 0) + 1;
    if ((l.acceptance_criteria || []).length > 0) withAcceptance++;
    if ((l.depends_on || []).length > 0) withDeps++;
  }

  // Local grunt ~$0; cloud specialist/architect ~$0.015–0.04 per leaf
  const costEstimateUsd = Math.round(cloudLeaves * 0.02 * 100) / 100;

  return {
    leafCount,
    areaCount: countAreas(nodes),
    estimatedMinutes,
    criticalPathMinutes: criticalPathMinutes(nodes),
    parallelWidth: parallelWidth(nodes),
    byAgentClass,
    byTool,
    costEstimateUsd,
    needsDeeper,
    withAcceptance,
    withDeps,
  };
}

export function computeFitMeter(
  nodes: any[],
  budgetMinutes: number,
  targets?: BudgetTargets
): FitMeter {
  const t = targets || computeBudgetTargets(budgetMinutes);
  const { leafCount, estimatedMinutes } = summarizeTreeEffort(nodes);
  const serialPad = t.budgetMinutes <= 15 ? 1.5 : t.budgetMinutes <= 60 ? 2 : 3;
  const ratio = t.budgetMinutes > 0 ? estimatedMinutes / (t.budgetMinutes * serialPad) : 0;
  // Fit against serial target matching computeBudgetTargets pad
  let status: FitStatus = 'unknown';
  if (leafCount === 0) status = 'unknown';
  else if (ratio < 0.7) status = 'under';
  else if (ratio <= 1.25) status = 'fit';
  else status = 'over';

  const messages: Record<FitStatus, string> = {
    under: `Tree is light — ${formatMinutes(estimatedMinutes)} serial vs ~${formatMinutes(t.budgetMinutes * serialPad)} target. Deepen further.`,
    fit: `Good fit — ${leafCount} leaves · ${formatMinutes(estimatedMinutes)} serial for ${t.label} wall-clock.`,
    over: `Over budget — ${formatMinutes(estimatedMinutes)} serial exceeds ~${formatMinutes(t.budgetMinutes * serialPad)} target. Parallelize or prune.`,
    unknown: 'Waiting for decomposition…',
  };

  return {
    status,
    budgetMinutes: t.budgetMinutes,
    estimatedMinutes,
    ratio,
    leafCount,
    targetLeaves: t.targetLeaves,
    label: t.label,
    message: messages[status],
  };
}

export const TIME_PRESETS: { label: string; minutes: number; value: string }[] = [
  { label: '20 sec', minutes: 1/3, value: '20 seconds' },
  { label: '1 min', minutes: 1, value: '1 minute' },
  { label: '5 min', minutes: 5, value: '5 minutes' },
  { label: '15 min', minutes: 15, value: '15 minutes' },
  { label: '30 min', minutes: 30, value: '30 minutes' },
  { label: '1 hour', minutes: 60, value: '1 hour' },
  { label: '2 hours', minutes: 120, value: '2 hours' },
  { label: '4 hours', minutes: 240, value: '4 hours' },
  { label: '8 hours', minutes: 480, value: '8 hours' },
  { label: '1 day', minutes: DAY, value: '1 day' },
  { label: '3 days', minutes: 3 * DAY, value: '3 days' },
  { label: '1 week', minutes: WEEK, value: '1 week' },
  { label: '2 weeks', minutes: 14 * DAY, value: '2 weeks' },
  { label: '1 month', minutes: 30 * DAY, value: '1 month' },
  { label: '2 months', minutes: 60 * DAY, value: '2 months' },
  { label: '100 days', minutes: MAX_DAYS * DAY, value: '100 days' },
  { label: 'Open-ended', minutes: MAX_DAYS * DAY, value: 'open-ended' },
];

/** Time-scaled delivery ambition for architect prompts / fallback trees. */
export function ambitionBrief(budgetMinutes: number): string {
  const m = Math.max(1 / 3, budgetMinutes || 60);
  if (m <= 15) {
    return `AMBITION: Rapid spike (~${formatMinutes(m)}). Ship one concrete, demoable slice with crisp acceptance criteria. No fluff areas.`;
  }
  if (m <= 60) {
    return `AMBITION: Focused build (~${formatMinutes(m)}). Deliver a working vertical slice end-to-end (scaffold → core feature → verify). Prefer depth over breadth.`;
  }
  if (m <= 180) {
    return `AMBITION: Solid MVP (~${formatMinutes(m)}). Architecture → implement core paths → tests → polish. Leaves must name real files/modules, not generic “setup 1”.`;
  }
  if (m <= DAY) {
    return `AMBITION: Full-day production push (~${formatMinutes(m)}). Phases: (1) foundation & scaffolding, (2) ship a runnable MVP, (3) harden quality (tests, errors, DX), (4) expand features, (5) iterate/refactor toward a monolithic high-quality codebase until the clock is used. Every leaf is a specific deliverable (path + acceptance). Ban generic labels like “Plan work”, “Setup 1”, “Unit 2”.`;
  }
  if (m <= 7 * DAY) {
    return `AMBITION: Multi-day product build (~${formatMinutes(m)}). Phases: discovery → MVP ship → quality bar → feature expansion → performance/security → continuous iteration. Sustain parallel workstreams that keep improving the same codebase until budget is exhausted.`;
  }
  return `AMBITION: Long-horizon program (~${formatMinutes(m)}). Organize into epics (platform, product surfaces, quality, ops) with MVP first, then continuous expansion and hardening for the full wall-clock. Leaves stay atomic but the overall plan is massive and production-grade.`;
}

export function phaseLabelsForBudget(budgetMinutes: number): string[] {
  const m = Math.max(1 / 3, budgetMinutes || 60);
  if (m <= 5) {
    return ['Do the work', 'Verify'];
  }
  if (m <= 15) {
    return ['Scaffold', 'Build', 'Verify'];
  }
  if (m <= 60) {
    return ['Clarify & scaffold', 'Core implementation', 'Verify & ship'];
  }
  if (m <= DAY) {
    return [
      'Foundation & architecture',
      'MVP vertical slice',
      'Quality & hardening',
      'Feature expansion',
      'Iterate & polish to clock',
    ];
  }
  return [
    'Discovery & contracts',
    'Platform foundation',
    'MVP ship',
    'Quality systems',
    'Product expansion',
    'Hardening & ops',
    'Continuous iteration',
  ];
}