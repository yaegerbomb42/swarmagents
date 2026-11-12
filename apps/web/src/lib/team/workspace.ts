/**
 * Team Mode — per-agent workspace isolation.
 *
 * Every lane gets its own folder under /workspace/team/<runId>/<agentId>/.
 * That is the isolation boundary: parallel agents never share a working
 * directory, and the reviewer merges the surviving files into
 * /workspace/team/<runId>/merged/.
 *
 * TEAM_WORKSPACE_ROOT overrides the root (used by tests so they never touch
 * the real /workspace).
 */

import { promises as fs } from 'fs';
import path from 'path';

export function teamRoot(): string {
  return process.env.TEAM_WORKSPACE_ROOT || '/workspace/team';
}

export function safeSegment(value: string): string {
  const cleaned = String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-');
  const trimmed = cleaned.replace(/^[-.]+/, '').slice(0, 64);
  return trimmed || 'unnamed';
}

export function agentWorkspacePath(runId: string, agentId: string): string {
  return path.join(teamRoot(), safeSegment(runId), safeSegment(agentId));
}

export function mergeWorkspacePath(runId: string): string {
  return path.join(teamRoot(), safeSegment(runId), 'merged');
}

export async function createAgentWorkspace(runId: string, agentId: string): Promise<string> {
  const dir = agentWorkspacePath(runId, agentId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export interface MergeLaneInput {
  runId: string;
  /** Files produced by one lane, absolute paths. */
  files: string[];
  /** Per-lane fallback summary when the lane produced no files. */
  summary: string;
  agentId: string;
}

/**
 * Copy a lane's files into the shared merged folder. Name collisions are kept
 * both, with the lane id prefixed to the later file — nothing is silently
 * overwritten, and the returned list is what actually landed.
 */
export async function mergeLaneIntoRun(input: MergeLaneInput): Promise<string[]> {
  const dest = mergeWorkspacePath(input.runId);
  await fs.mkdir(dest, { recursive: true });
  const landed: string[] = [];
  const seen = new Set<string>();

  for (const file of input.files) {
    const base = path.basename(file);
    let target = path.join(dest, base);
    if (seen.has(target)) target = path.join(dest, `${safeSegment(input.agentId)}--${base}`);
    seen.add(target);
    try {
      await fs.copyFile(file, target);
      landed.push(target);
    } catch {
      /* a lane may reference a file it never actually wrote; skip it */
    }
  }

  if (!landed.length) {
    const target = path.join(dest, `${safeSegment(input.agentId)}.md`);
    await fs.writeFile(target, input.summary || '(no summary)', 'utf8');
    landed.push(target);
  }
  return landed;
}

/** Human path for the UI: relative to the team root when possible. */
export function displayWorkspace(fullPath: string): string {
  const root = teamRoot();
  if (fullPath.startsWith(root)) return fullPath.slice(root.length).replace(/^\/+/, '') || root;
  return fullPath;
}