/**
 * Unified project context — sliceable for each seat.
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { DecompSessionRecord } from '@/lib/decompSessions';
import type { BlackboardPost } from '@/lib/sessionBlackboard';

export type ProjectContext = {
  version: 1;
  goal: string;
  constraints: string[];
  decisions: string[];
  openQuestions: string[];
  ownership: Record<string, string>; // path -> seat title
  milestoneId?: string;
  updatedAt: number;
};

function contextJsonPath(workspace: string): string {
  return path.join(workspace, '.swarm', 'context.json');
}

function contextMdPath(workspace: string): string {
  return path.join(workspace, 'CONTEXT.md');
}

export function emptyContext(goal: string): ProjectContext {
  return {
    version: 1,
    goal: goal || '',
    constraints: [],
    decisions: [],
    openQuestions: [],
    ownership: {},
    updatedAt: Date.now(),
  };
}

export async function loadProjectContext(
  workspace: string,
  session?: DecompSessionRecord
): Promise<ProjectContext> {
  try {
    const raw = await fs.readFile(contextJsonPath(workspace), 'utf8');
    const parsed = JSON.parse(raw) as ProjectContext;
    if (parsed?.version === 1) return parsed;
  } catch {
    /* create */
  }
  const goal = String(
    (session as { goal?: string } | undefined)?.goal ||
      session?.project_title ||
      session?.project ||
      ''
  );
  const ctx = emptyContext(goal);
  if (session?.mission?.constraints) ctx.constraints = [...session.mission.constraints];
  await saveProjectContext(workspace, ctx);
  return ctx;
}

export async function saveProjectContext(
  workspace: string,
  ctx: ProjectContext
): Promise<void> {
  ctx.updatedAt = Date.now();
  await fs.mkdir(path.join(workspace, '.swarm'), { recursive: true });
  await fs.writeFile(contextJsonPath(workspace), JSON.stringify(ctx, null, 2), 'utf8');
  const md = [
    `# Project context`,
    ``,
    `## Goal`,
    ctx.goal || '(unset)',
    ``,
    `## Constraints`,
    ...(ctx.constraints.length ? ctx.constraints.map((c) => `- ${c}`) : ['- (none)']),
    ``,
    `## Decisions`,
    ...(ctx.decisions.length ? ctx.decisions.map((d) => `- ${d}`) : ['- (none yet)']),
    ``,
    `## Open questions`,
    ...(ctx.openQuestions.length ? ctx.openQuestions.map((q) => `- ${q}`) : ['- (none)']),
    ``,
    `## Ownership`,
    ...Object.entries(ctx.ownership).map(([p, seat]) => `- \`${p}\` → ${seat}`),
    ``,
    `Updated: ${new Date(ctx.updatedAt).toISOString()}`,
    ``,
  ].join('\n');
  await fs.writeFile(contextMdPath(workspace), md, 'utf8');
}

export function sliceContextForSeat(
  ctx: ProjectContext,
  opts: { ownsPaths: string[]; seatTitle: string; blackboard?: BlackboardPost[] }
): string {
  const owns = opts.ownsPaths || [];
  const relatedDecisions = ctx.decisions.filter((d) =>
    owns.some((p) => d.toLowerCase().includes(p.toLowerCase().split('/').pop() || ''))
  );
  const ownershipLines = owns.map((p) => `${p} (you)`);
  for (const [p, seat] of Object.entries(ctx.ownership)) {
    if (!owns.includes(p)) ownershipLines.push(`${p} → ${seat}`);
  }
  const bb = (opts.blackboard || [])
    .filter((x) => x.kind === 'decision' || x.kind === 'blocker')
    .slice(-4)
    .map((x) => x.text);

  return [
    `Agent: ${opts.seatTitle}`,
    `Goal: ${ctx.goal.slice(0, 400)}`,
    ctx.constraints.length ? `Constraints: ${ctx.constraints.slice(0, 5).join('; ')}` : '',
    relatedDecisions.length
      ? `Relevant decisions: ${relatedDecisions.slice(0, 5).join('; ')}`
      : ctx.decisions.length
        ? `Recent decisions: ${ctx.decisions.slice(-3).join('; ')}`
        : '',
    ownershipLines.length ? `Ownership: ${ownershipLines.slice(0, 8).join(', ')}` : '',
    bb.length ? `Team signals: ${bb.join(' | ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function mergeBlackboardIntoContext(
  workspace: string,
  ctx: ProjectContext,
  posts: BlackboardPost[]
): Promise<ProjectContext> {
  for (const p of posts.slice(-20)) {
    if (p.kind === 'decision' && p.text && !ctx.decisions.includes(p.text)) {
      ctx.decisions.push(p.text.slice(0, 300));
    }
    if (p.kind === 'ask' && p.text && !ctx.openQuestions.includes(p.text)) {
      ctx.openQuestions.push(p.text.slice(0, 300));
    }
    if (p.kind === 'file_ptr' && p.path && p.seatId) {
      ctx.ownership[p.path] = p.seatId;
    }
  }
  ctx.decisions = ctx.decisions.slice(-40);
  ctx.openQuestions = ctx.openQuestions.slice(-20);
  await saveProjectContext(workspace, ctx);
  return ctx;
}

export function attachContextToSession(
  session: DecompSessionRecord,
  ctx: ProjectContext
): void {
  (session as { projectContext?: ProjectContext }).projectContext = ctx;
}
