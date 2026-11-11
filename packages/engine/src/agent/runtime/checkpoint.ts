import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface Snapshot {
  treeSha: string;
  timestamp: number;
}

const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * A throwaway git-tree snapshotter.
 *
 * Snapshots and restores the working tree (including untracked files) through an isolated
 * `GIT_INDEX_FILE`, so the user's real `.git/index`, `HEAD`, and branch refs are never touched.
 * The `index` is created under the OS temp dir and removed in a `finally` block.
 */
export class GitTreeSnapshotter {
  constructor(private readonly repoRoot: string) {}

  /** Capture the working tree + untracked files as a tree, returning its SHA. */
  async snapshot(): Promise<Snapshot> {
    const indexPath = this.newIndexPath();
    try {
      await this.git(indexPath, ['read-tree', 'HEAD']);
      await this.git(indexPath, ['add', '-A']);
      const treeSha = await this.git(indexPath, ['write-tree']);
      return { treeSha, timestamp: Date.now() };
    } finally {
      await rm(indexPath, { force: true }).catch(() => undefined);
    }
  }

  /** Reset the working tree to a previously captured snapshot. */
  async restore(snapshot: Snapshot): Promise<void> {
    const indexPath = this.newIndexPath();
    try {
      await this.git(indexPath, ['read-tree', snapshot.treeSha]);
      await this.git(indexPath, ['checkout-index', `--prefix=${this.repoRoot}/`, '-a', '-f']);
      await this.removeUntracked(indexPath);
    } finally {
      await rm(indexPath, { force: true }).catch(() => undefined);
    }
  }

  private newIndexPath(): string {
    return path.join(tmpdir(), `omnexx-snap-${randomUUID()}.index`);
  }

  /** Run a git command against the throwaway index file. */
  private git(indexPath: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        [...args],
        {
          cwd: this.repoRoot,
          env: { ...process.env, GIT_INDEX_FILE: indexPath },
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(`git ${args.join(' ')} failed: ${(stderr || '').trim() || error.message}`),
            );
            return;
          }
          resolve(stdout.trim());
        },
      );
    });
  }

  /**
   * Delete working-tree files that are not present in the snapshot tree. Because the throwaway
   * index holds the snapshot tree, `git ls-files --others` lists exactly the files created
   * after the snapshot — those get removed so restore() fully reverts the tree.
   */
  private async removeUntracked(indexPath: string): Promise<void> {
    const out = await this.git(indexPath, ['ls-files', '--others', '--exclude-standard', '-z']);
    if (!out) return;
    const root = path.resolve(this.repoRoot);
    const prefix = `${root}${path.sep}`;
    for (const relative of out.split('\0')) {
      if (!relative) continue;
      const abs = path.resolve(root, relative);
      if (!abs.startsWith(prefix) && abs !== root) continue;
      await rm(abs, { force: true }).catch(() => undefined);
    }
  }
}
