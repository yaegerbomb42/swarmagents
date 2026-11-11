/**
 * Foolproof decomposition helpers — intake, JSON repair, heuristic trees.
 * Used when the LLM fails, returns garbage, or the mission is underspecified.
 */

import {
  type BudgetTargets,
  formatMinutes,
  phaseLabelsForBudget,
} from '@/lib/timeBudget';

export type MissionDomain =
  | 'software'
  | 'research'
  | 'content'
  | 'ops'
  | 'data'
  | 'design'
  | 'general';

export interface SanitizedMission {
  raw: string;
  text: string;
  title: string;
  domain: MissionDomain;
  vague: boolean;
  constraints: string[];
}

const DOMAIN_HINTS: Record<MissionDomain, RegExp[]> = {
  software: [
    /\b(api|code|repo|bug|test|deploy|docker|typescript|react|backend|frontend|refactor|ci\/cd|sdk)\b/i,
    /\b(build|implement|fix|ship)\b.+\b(app|service|endpoint|component)\b/i,
  ],
  research: [
    /\b(research|analyze|survey|benchmark|compare|literature|investigate|study)\b/i,
  ],
  content: [
    /\b(write|blog|docs?|documentation|copy|article|newsletter|script)\b/i,
  ],
  ops: [
    /\b(ops|infra|kubernetes|k8s|terraform|monitor|alert|incident|sre|pipeline)\b/i,
  ],
  data: [
    /\b(dataset|etl|sql|warehouse|analytics|pipeline|feature.?store|ml|model.?train)\b/i,
  ],
  design: [
    /\b(design|figma|ux|ui|wireframe|prototype|brand)\b/i,
  ],
  general: [],
};

const VAGUE_RE =
  /^(fix|build|improve|help|do|make|update|work on|handle|stuff|things?)\b/i;

const STEER_MAX_LEN = 2000;

/** Strip control chars and clamp user steer/chat input length. */
export function sanitizeUserInput(input: unknown, maxLen = STEER_MAX_LEN): string {
  return String(input ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLen);
}

export function detectDomain(text: string): MissionDomain {
  for (const [domain, patterns] of Object.entries(DOMAIN_HINTS) as [
    MissionDomain,
    RegExp[],
  ][]) {
    if (domain === 'general') continue;
    if (patterns.some((re) => re.test(text))) return domain;
  }
  return 'general';
}

export function sanitizeMission(input: unknown): SanitizedMission {
  const raw = String(input ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .trim();

  let text = raw.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').slice(0, 4000);
  if (!text) {
    text =
      'Unspecified objective. Clarify goals, define deliverables, execute the work, and verify completion.';
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const vague = wordCount < 6 || (wordCount < 12 && VAGUE_RE.test(text));

  if (vague) {
    text = [
      `Objective: ${raw || text}`,
      'Expand into a concrete mission: clarify scope and success criteria,',
      'break work into atomic steps a small model can finish,',
      'execute each step, verify outputs, and package a final deliverable.',
    ].join(' ');
  }

  const constraints: string[] = [];
  if (/\bno\s+(tests?|docs?)\b/i.test(raw)) constraints.push('respect explicit exclusions');
  if (/\bproduction\b/i.test(raw)) constraints.push('production-safe changes only');
  if (/\bread[- ]?only\b/i.test(raw)) constraints.push('read-only where possible');

  const title = (raw.split(/[.!?\n]/)[0] || text).trim().slice(0, 80) || 'Untitled mission';
  const domain = detectDomain(raw || text);

  return { raw: raw || text, text, title, domain, vague, constraints };
}

/** Extract / repair JSON object from messy model output. */
export function parseModelJson(raw: unknown): Record<string, unknown> {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('empty_model_output');

  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text);

  let lastErr: Error | null = null;
  for (const c of candidates) {
    for (const attempt of [c, repairJsonText(c)]) {
      try {
        const parsed = JSON.parse(attempt);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
        if (Array.isArray(parsed)) return { nodes: parsed };
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
      }
    }
  }
  throw lastErr || new Error('json_parse_failed');
}

function repairJsonText(s: string): string {
  let t = s
    .replace(/^\uFEFF/, '')
    .replace(/,\s*([}\]])/g, '$1') // trailing commas
    .replace(/(\{|\,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":') // unquoted keys
    .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ':"$1"'); // single-quoted strings

  // Balance braces/brackets if truncated
  const opens = (t.match(/\{/g) || []).length;
  const closes = (t.match(/\}/g) || []).length;
  if (opens > closes) t += '}'.repeat(opens - closes);
  const o2 = (t.match(/\[/g) || []).length;
  const c2 = (t.match(/\]/g) || []).length;
  if (o2 > c2) t += ']'.repeat(o2 - c2);
  return t;
}

export function slugId(label: string, fallback: string): string {
  const s = String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return s || fallback;
}

const DOMAIN_AREAS: Record<
  MissionDomain,
  { id: string; label: string; description: string; tools: string[] }[]
> = {
  software: [
    { id: 'scope', label: 'Scope & contracts', description: 'Clarify requirements, interfaces, and acceptance.', tools: ['search', 'edit'] },
    { id: 'foundation', label: 'Foundation', description: 'Scaffold structure, types, and shared utilities.', tools: ['edit', 'shell'] },
    { id: 'core', label: 'Core implementation', description: 'Build primary features in atomic slices.', tools: ['edit', 'shell'] },
    { id: 'verify', label: 'Verification', description: 'Tests, lint, and smoke checks.', tools: ['test', 'shell'] },
    { id: 'ship', label: 'Ship & docs', description: 'Docs, runbook, and delivery packaging.', tools: ['edit'] },
  ],
  research: [
    { id: 'brief', label: 'Research brief', description: 'Define questions, sources, and success criteria.', tools: ['search', 'edit'] },
    { id: 'gather', label: 'Evidence gathering', description: 'Collect and annotate primary sources.', tools: ['search', 'browser'] },
    { id: 'synthesize', label: 'Synthesis', description: 'Compare findings and extract decisions.', tools: ['edit', 'search'] },
    { id: 'report', label: 'Report', description: 'Write recommendations with citations.', tools: ['edit'] },
  ],
  content: [
    { id: 'outline', label: 'Outline', description: 'Audience, outline, and tone.', tools: ['edit', 'search'] },
    { id: 'draft', label: 'Draft', description: 'Write sections as atomic units.', tools: ['edit'] },
    { id: 'polish', label: 'Polish', description: 'Edit for clarity, facts, and style.', tools: ['edit', 'search'] },
    { id: 'publish', label: 'Publish pack', description: 'Final format, metadata, and checklist.', tools: ['edit'] },
  ],
  ops: [
    { id: 'assess', label: 'Assess', description: 'Inventory current state and risks.', tools: ['shell', 'search'] },
    { id: 'plan', label: 'Change plan', description: 'Rollout, rollback, and ownership.', tools: ['edit'] },
    { id: 'apply', label: 'Apply changes', description: 'Execute infra/config changes safely.', tools: ['shell', 'edit'] },
    { id: 'validate', label: 'Validate', description: 'Health checks and monitoring.', tools: ['shell', 'test'] },
  ],
  data: [
    { id: 'ingest', label: 'Ingest & schema', description: 'Sources, schema, and contracts.', tools: ['edit', 'shell'] },
    { id: 'transform', label: 'Transform', description: 'ETL / feature steps.', tools: ['edit', 'shell'] },
    { id: 'quality', label: 'Data quality', description: 'Validation and anomaly checks.', tools: ['test', 'shell'] },
    { id: 'deliver', label: 'Deliver', description: 'Publish artifacts and docs.', tools: ['edit'] },
  ],
  design: [
    { id: 'discover', label: 'Discover', description: 'Users, constraints, and references.', tools: ['search', 'browser'] },
    { id: 'structure', label: 'Structure', description: 'IA, flows, and component map.', tools: ['edit'] },
    { id: 'visual', label: 'Visual system', description: 'Layout, type, and interaction states.', tools: ['edit', 'browser'] },
    { id: 'handoff', label: 'Handoff', description: 'Specs and acceptance notes.', tools: ['edit'] },
  ],
  general: [
    { id: 'foundation', label: 'Foundation', description: 'Contracts, scaffolding, and runnable skeleton for the mission.', tools: ['search', 'edit'] },
    { id: 'mvp', label: 'MVP ship', description: 'First end-to-end vertical slice users can run.', tools: ['edit', 'shell'] },
    { id: 'quality', label: 'Quality & hardening', description: 'Tests, error paths, and acceptance gates.', tools: ['test', 'edit'] },
    { id: 'expand', label: 'Feature expansion', description: 'Next high-value capabilities on the same codebase.', tools: ['edit', 'shell'] },
    { id: 'iterate', label: 'Iterate to clock', description: 'Refactor, polish, and deepen quality until budget is used.', tools: ['edit', 'test'] },
  ],
};

function leafTemplate(
  areaId: string,
  index: number,
  label: string,
  description: string,
  tools: string[],
  effort: number,
  priority: string,
  dependsOn: string[] = []
) {
  const id = `${areaId}-t${index}`;
  return {
    id,
    type: 'task',
    label,
    description,
    acceptance_criteria: [
      `Output for “${label}” exists and matches the description`,
      'No blocking errors remain for this step',
    ],
    priority,
    effort_minutes: effort,
    needs_deeper: effort > 8,
    depends_on: dependsOn,
    agent_class: tools.includes('test') ? 'qa' : tools.includes('search') ? 'research' : 'grunt',
    model_tier: tools.includes('browser') || label.toLowerCase().includes('architect')
      ? 'specialist'
      : 'grunt',
    tools,
    deliverable_path: `deliverables/${areaId}/${index}`,
    status: 'pending',
  };
}

function slugifyMission(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'mission';
}

function concreteLeafPlan(
  missionTitle: string,
  areaLabel: string,
  areaId: string,
  count: number,
  domain: MissionDomain
): Array<{ label: string; description: string; tools: string[]; path: string }> {
  const short = missionTitle.slice(0, 64);
  const slug = slugifyMission(missionTitle);
  const basePath =
    domain === 'software'
      ? `src/${slug}`
      : domain === 'research'
        ? `research/${slug}`
        : domain === 'content'
          ? `content/${slug}`
          : `deliverables/${slug}`;

  const catalog: Array<{ label: string; description: string; tools: string[]; path: string }> = [
    {
      label: `Contracts & done-definition for ${short}`,
      description: `Write precise inputs/outputs and acceptance for “${short}” under ${areaLabel}.`,
      tools: ['edit', 'search'],
      path: `${basePath}/${areaId}/contracts.md`,
    },
    {
      label: `Scaffold ${areaLabel} for ${short}`,
      description: `Create the minimal runnable structure/files for ${areaLabel} serving “${short}”.`,
      tools: domain === 'software' ? ['edit', 'shell'] : ['edit'],
      path: `${basePath}/${areaId}/scaffold`,
    },
    {
      label: `Implement core path — ${areaLabel}`,
      description: `Build the primary capability for ${areaLabel} in “${short}” with a concrete deliverable.`,
      tools: ['edit', 'shell'],
      path: `${basePath}/${areaId}/core`,
    },
    {
      label: `Wire integration — ${areaLabel}`,
      description: `Connect ${areaLabel} to adjacent modules so “${short}” has an end-to-end path.`,
      tools: ['edit', 'shell'],
      path: `${basePath}/${areaId}/integration`,
    },
    {
      label: `Tests & acceptance — ${areaLabel}`,
      description: `Add checks proving ${areaLabel} meets acceptance for “${short}”.`,
      tools: ['test', 'shell'],
      path: `${basePath}/${areaId}/tests`,
    },
    {
      label: `Harden errors & edge cases — ${areaLabel}`,
      description: `Handle failure modes and edge cases in ${areaLabel} for production quality.`,
      tools: ['edit', 'test'],
      path: `${basePath}/${areaId}/harden`,
    },
    {
      label: `Ship checkpoint: ${areaLabel} runnable`,
      description: `Make ${areaLabel} demoable/runnable as part of the MVP for “${short}”.`,
      tools: ['shell', 'edit'],
      path: `${basePath}/${areaId}/ship`,
    },
    {
      label: `Expand features on ${areaLabel}`,
      description: `Add the next high-value capability on top of the shipped ${areaLabel} for “${short}”.`,
      tools: ['edit', 'shell'],
      path: `${basePath}/${areaId}/expand`,
    },
    {
      label: `Iterate quality — ${areaLabel}`,
      description: `Refactor, document, and deepen quality in ${areaLabel} until the time budget is used.`,
      tools: ['edit', 'test'],
      path: `${basePath}/${areaId}/iterate`,
    },
  ];

  const out: Array<{ label: string; description: string; tools: string[]; path: string }> = [];
  for (let i = 0; i < count; i++) {
    const t = catalog[i % catalog.length];
    const round = Math.floor(i / catalog.length);
    out.push(
      round === 0
        ? t
        : {
            ...t,
            label: `${t.label} (pass ${round + 1})`,
            path: `${t.path}-p${round + 1}`,
          }
    );
  }
  return out;
}

/** Always-valid heuristic tree sized to budget — never empty. */
export function buildFallbackTree(
  mission: SanitizedMission,
  targets: BudgetTargets
): { project_title: string; total_effort_estimate: string; nodes: any[]; source: 'fallback' } {
  const phaseNames = phaseLabelsForBudget(targets.budgetMinutes);
  const catalog = DOMAIN_AREAS[mission.domain] || DOMAIN_AREAS.general;
  const areaCount = Math.min(
    Math.max(targets.topLevelAreas.min, Math.min(phaseNames.length, targets.topLevelAreas.max)),
    Math.min(targets.topLevelAreas.max, catalog.length + 2, phaseNames.length || 1)
  );

  const areas = Array.from({ length: Math.min(areaCount, phaseNames.length) }, (_, i) => {
    const phase = phaseNames[i] || catalog[i % catalog.length]?.label || `Phase ${i + 1}`;
    const base = catalog[i % catalog.length] || DOMAIN_AREAS.general[i % DOMAIN_AREAS.general.length];
    return {
      id: `p${i + 1}-${base.id}`,
      label: `${phase}: ${mission.title.slice(0, 40)}`,
      description: `${phase}. ${base.description} Mission: ${mission.title}.`,
      tools: base.tools,
    };
  });

  const targetLeaves = Math.max(
    targets.budgetMinutes <= 5 ? 2 : 3,
    Math.min(targets.targetLeaves, targets.maxLeaves),
  );
  const perArea = Math.max(
    targets.childrenPerArea.min,
    Math.min(
      targets.childrenPerArea.max,
      Math.ceil(targetLeaves / Math.max(1, areas.length))
    )
  );
  const leafEffort = Math.max(
    targets.budgetMinutes <= 5 ? 1 : 1,
    Math.round(targets.targetLeafMinutes) || 1,
  );

  const nodes = areas.map((area, ai) => {
    const plan = concreteLeafPlan(mission.title, area.label, area.id, perArea, mission.domain);
    const children = plan.map((step, idx) => {
      const i = idx + 1;
      const prev = i > 1 ? [`${area.id}-t${i - 1}`] : ai > 0 ? [`${areas[ai - 1].id}-t${perArea}`] : [];
      const leaf = leafTemplate(
        area.id,
        i,
        step.label.slice(0, 120),
        step.description.slice(0, 400),
        step.tools,
        leafEffort + (i === 1 ? 1 : 0),
        ai === 0 || i === 1 ? 'critical' : i === perArea ? 'high' : 'medium',
        prev.slice(0, 1)
      );
      leaf.deliverable_path = step.path;
      return leaf;
    });
    return {
      id: `area-${area.id}`,
      type: 'area',
      label: area.label.slice(0, 120),
      description: `${area.description} Context: ${mission.text.slice(0, 180)}`,
      priority: ai === 0 ? 'critical' : 'high',
      effort_minutes: children.reduce((s, c) => s + c.effort_minutes, 0),
      needs_deeper: false,
      depends_on: ai > 0 ? [`area-${areas[ai - 1].id}`] : [],
      agent_class: 'architect',
      status: 'pending',
      children,
    };
  });

  return {
    project_title: mission.title,
    total_effort_estimate: formatMinutes(targets.budgetMinutes),
    nodes,
    source: 'fallback',
  };
}

/** Heuristic split when deepen LLM fails. */
export function heuristicSplitLeaf(
  parent: any,
  targets: BudgetTargets
): any[] {
  const base = slugId(parent.label || parent.id, parent.id || 'task');
  const effort = Math.max(
    targets.targetLeafMinutes,
    Math.round((Number(parent.effort_minutes) || targets.deepenAboveMinutes * 2) / 3)
  );
  const tools = Array.isArray(parent.tools) && parent.tools.length
    ? parent.tools
    : ['edit'];
  const parts = [
    {
      suffix: 'spec',
      label: `Specify contracts: ${parent.label || parent.id}`,
      description: `Define exact inputs/outputs, file paths, and acceptance for: ${parent.description || parent.label}`,
      tools: ['edit', 'search'],
    },
    {
      suffix: 'do',
      label: `Implement deliverable: ${parent.label || parent.id}`,
      description: `Produce the concrete artifact for: ${parent.description || parent.label}`,
      tools,
    },
    {
      suffix: 'check',
      label: `Verify acceptance: ${parent.label || parent.id}`,
      description: `Validate the result against acceptance criteria for: ${parent.label || parent.id}`,
      tools: tools.includes('test') ? ['test', 'shell'] : ['test', 'search'],
    },
  ];

  return parts.map((p, i) => ({
    id: `${parent.id || base}-${p.suffix}`,
    type: 'task',
    label: p.label.slice(0, 120),
    description: p.description.slice(0, 400),
    acceptance_criteria: [
      `“${p.suffix}” step complete for ${parent.label || parent.id}`,
      'Artifacts are usable by the next dependent task',
    ],
    priority: parent.priority || 'high',
    effort_minutes: Math.min(targets.deepenAboveMinutes, Math.max(1, effort)),
    needs_deeper: false,
    depends_on: i > 0 ? [`${parent.id || base}-${parts[i - 1].suffix}`] : [],
    agent_class: p.suffix === 'check' ? 'qa' : parent.agent_class || 'grunt',
    model_tier: p.suffix === 'spec' ? 'specialist' : 'grunt',
    tools: p.tools,
    deliverable_path: parent.deliverable_path
      ? `${parent.deliverable_path}/${p.suffix}`
      : `deliverables/${parent.id || base}/${p.suffix}`,
    status: 'pending',
  }));
}

export interface RepairStats {
  uniqueIds: number;
  droppedDeps: number;
  filledLeaves: number;
  usedFallbackShape: boolean;
}

function walkLeaves(nodes: any[], out: any[] = []): any[] {
  for (const n of nodes || []) {
    if (n.children?.length) walkLeaves(n.children, out);
    else out.push(n);
  }
  return out;
}

function collectIds(nodes: any[], set = new Set<string>()): Set<string> {
  for (const n of nodes || []) {
    if (n.id) set.add(String(n.id));
    if (n.children?.length) collectIds(n.children, set);
  }
  return set;
}

/** Enforce unique IDs, sane deps, minimum leaf fields. */
export function repairTreeStructure(
  nodes: any[],
  targets: BudgetTargets,
  mission?: SanitizedMission
): { nodes: any[]; stats: RepairStats } {
  const stats: RepairStats = {
    uniqueIds: 0,
    droppedDeps: 0,
    filledLeaves: 0,
    usedFallbackShape: false,
  };

  const seen = new Set<string>();
  const ensureId = (raw: string, fallback: string) => {
    let id = String(raw || fallback).replace(/\s+/g, '-').slice(0, 64) || fallback;
    if (!seen.has(id)) {
      seen.add(id);
      return id;
    }
    let i = 2;
    while (seen.has(`${id}-${i}`)) i++;
    const next = `${id}-${i}`;
    seen.add(next);
    stats.uniqueIds++;
    return next;
  };

  const rewrite = (list: any[], depth = 0): any[] =>
    (list || []).map((n, i) => {
      const id = ensureId(n.id || slugId(n.label, `node-${depth}-${i + 1}`), `node-${depth}-${i + 1}`);
      const children = n.children?.length ? rewrite(n.children, depth + 1) : undefined;
      const isLeaf = !children?.length;
      const effort = Math.max(1, Number(n.effort_minutes) || targets.targetLeafMinutes);
      if (isLeaf) stats.filledLeaves++;
      return {
        ...n,
        id,
        type: n.type || (children?.length ? 'area' : 'task'),
        label: String(n.label || n.description || id).slice(0, 160),
        description: String(n.description || n.label || mission?.text || '').slice(0, 600),
        effort_minutes: effort,
        needs_deeper:
          Boolean(n.needs_deeper) ||
          (isLeaf && effort > targets.deepenAboveMinutes && depth < targets.maxDepth),
        depends_on: Array.isArray(n.depends_on) ? n.depends_on.map(String) : [],
        priority: ['critical', 'high', 'medium', 'low'].includes(n.priority)
          ? n.priority
          : isLeaf
            ? 'medium'
            : 'high',
        status: n.status || 'pending',
        children,
      };
    });

  let next = rewrite(nodes || []);
  const ids = collectIds(next);

  const scrubDeps = (list: any[]) => {
    for (const n of list || []) {
      const before = (n.depends_on || []).length;
      n.depends_on = (n.depends_on || []).filter(
        (d: string) => ids.has(d) && d !== n.id
      );
      stats.droppedDeps += before - n.depends_on.length;
      if (n.children?.length) scrubDeps(n.children);
    }
  };
  scrubDeps(next);

  const leaves = walkLeaves(next);
  if (leaves.length < 3 && mission) {
    const fb = buildFallbackTree(mission, targets);
    next = fb.nodes;
    stats.usedFallbackShape = true;
  }

  return { nodes: next, stats };
}

export function extractNodesFromModel(result: Record<string, unknown>): any[] {
  if (Array.isArray(result.nodes)) return result.nodes;
  if (Array.isArray(result.subtasks)) return result.subtasks;
  if (Array.isArray(result.tasks)) return result.tasks;
  if (Array.isArray(result.tree)) return result.tree;
  // Sometimes model nests under project
  const project = result.project as Record<string, unknown> | undefined;
  if (project && Array.isArray(project.nodes)) return project.nodes;
  return [];
}

export function domainPromptHint(domain: MissionDomain): string {
  switch (domain) {
    case 'software':
      return 'This is a software mission — prefer file-level, testable leaves with deliverable_path.';
    case 'research':
      return 'This is a research mission — prefer source-gathering, synthesis, and citation leaves.';
    case 'content':
      return 'This is a content mission — prefer outline/section/edit/publish leaves.';
    case 'ops':
      return 'This is an ops/infra mission — prefer assess/change/validate leaves with rollback notes.';
    case 'data':
      return 'This is a data mission — prefer schema/transform/quality/publish leaves.';
    case 'design':
      return 'This is a design mission — prefer discover/structure/visual/handoff leaves.';
    default:
      return 'Domain is general — invent the most practical work breakdown for the stated objective.';
  }
}
