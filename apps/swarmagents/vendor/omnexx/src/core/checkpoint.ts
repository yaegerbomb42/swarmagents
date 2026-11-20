import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { readJson, writeFileAtomic } from './atomic.js';
import { headSha, statusPorcelain } from '../git/repo.js';

export interface StepEvidence {
  command?: string | undefined;
  output?: string | undefined;
  checkResults?: unknown;
  commitSha?: string | undefined;
  filesModified?: string[] | undefined;
  timestamp?: number | undefined;
}

export interface CheckpointStep {
  id: string;
  title: string;
  status: 'completed' | 'unverified, recheck';
  evidence?: StepEvidence | undefined;
  filesModified: string[];
  fileHashes: Record<string, string>; // relative path -> sha256 at completion
}

export interface NextAction {
  phase: string;
  step?: string | undefined;
  taskId?: string | undefined;
  description?: string | undefined;
  retries?: number | undefined;
}

export interface TaskCheckpoint {
  version: 1;
  id: string;
  goal: string;
  acceptanceCriteria: string[];
  completedSteps: CheckpointStep[];
  openDecisions: string[];
  nextAction: NextAction;
  gitHead: string;
  dirtyFileHashes: Record<string, string>;
  model: string;
  provider: string;
  status: 'running' | 'paused' | 'parked' | 'finished';
  updatedAt: number;
}

export const taskCheckpointPath = (root: string, id: string): string =>
  join(root, '.omnexx', 'task', id, 'checkpoint.json');

export async function computeFileHash(filePath: string): Promise<string> {
  try {
    const data = await readFile(filePath);
    return createHash('sha256').update(data).digest('hex');
  } catch {
    return '';
  }
}

export async function computeDirtyHashes(cwd: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const status = await statusPorcelain(cwd).catch(() => '');
  if (!status.trim()) return hashes;
  const lines = status.split('\n').filter((l) => l.trim().length > 0);
  for (const line of lines) {
    let file = line.slice(3).trim();
    if (file.includes(' -> ')) {
      file = file.split(' -> ')[1]?.trim() ?? file;
    }
    if (file.startsWith('"') && file.endsWith('"')) {
      file = file.slice(1, -1);
    }
    const fullPath = join(cwd, file);
    hashes[file] = await computeFileHash(fullPath);
  }
  return hashes;
}

export async function writeTaskCheckpointAtomic(
  root: string,
  checkpoint: TaskCheckpoint,
): Promise<void> {
  const path = taskCheckpointPath(root, checkpoint.id);
  checkpoint.updatedAt = Date.now();
  await writeFileAtomic(path, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

export async function readTaskCheckpoint(
  root: string,
  id: string,
): Promise<TaskCheckpoint | undefined> {
  const path = taskCheckpointPath(root, id);
  try {
    const data = await readJson(path);
    return data as TaskCheckpoint;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // If root is a git worktree, inspect .git pointer file to find main repo
  try {
    const gitPath = join(root, '.git');
    const content = await readFile(gitPath, 'utf8');
    const match = /gitdir:\s*(.*)/.exec(content);
    if (match?.[1]) {
      const gitDir = isAbsolute(match[1].trim()) ? match[1].trim() : join(root, match[1].trim());
      // e.g. <repo>/.git/worktrees/<name> -> dirname(dirname(gitDir)) is <repo>/.git
      const repoGit = dirname(dirname(gitDir));
      const repoRoot = dirname(repoGit);
      const repoPath = taskCheckpointPath(repoRoot, id);
      const data = await readJson(repoPath);
      return data as TaskCheckpoint;
    }
  } catch {
    // Non-fatal if not a worktree or cannot read
  }

  return undefined;
}

export interface ReconcileResult {
  checkpoint: TaskCheckpoint;
  headMoved: boolean;
  currentHead: string;
  checkpointHead: string;
  unverifiedSteps: string[];
  verifiedSteps: string[];
  details: string[];
}

/**
 * Reconcile a checkpoint against the real disk state.
 * Never trust a summary over the disk:
 * 1. Checks current git HEAD against checkpoint HEAD.
 * 2. Re-hashes every file in dirtyFileHashes and in each completed step's filesModified.
 * 3. Any step whose files were modified outside the agent is marked "unverified, recheck".
 */
export async function reconcileCheckpoint(
  cwd: string,
  checkpoint: TaskCheckpoint,
): Promise<ReconcileResult> {
  const currentHead = await headSha(cwd).catch(() => checkpoint.gitHead);
  const originalHead = checkpoint.gitHead;
  const headMoved = currentHead !== originalHead;
  const unverifiedSteps: string[] = [];
  const verifiedSteps: string[] = [];
  const details: string[] = [];

  if (headMoved) {
    details.push(
      `Git HEAD moved: checkpoint recorded ${originalHead.slice(0, 8)}, current HEAD is ${currentHead.slice(0, 8)}`,
    );
  }

  for (const step of checkpoint.completedSteps) {
    let invalidated = false;
    for (const file of step.filesModified) {
      const fullPath = join(cwd, file);
      const currentHash = await computeFileHash(fullPath);
      const recordedHash = step.fileHashes[file];
      if (recordedHash && currentHash !== recordedHash) {
        invalidated = true;
        details.push(
          `Step "${step.title}" (${step.id}): file "${file}" changed outside agent (recorded ${recordedHash.slice(0, 8)}, now ${currentHash ? currentHash.slice(0, 8) : 'deleted'})`,
        );
      }
    }

    if (invalidated) {
      step.status = 'unverified, recheck';
      unverifiedSteps.push(step.id);
    } else {
      verifiedSteps.push(step.id);
    }
  }

  checkpoint.dirtyFileHashes = await computeDirtyHashes(cwd);
  checkpoint.gitHead = currentHead;
  checkpoint.updatedAt = Date.now();

  return {
    checkpoint,
    headMoved,
    currentHead,
    checkpointHead: originalHead,
    unverifiedSteps,
    verifiedSteps,
    details,
  };
}
