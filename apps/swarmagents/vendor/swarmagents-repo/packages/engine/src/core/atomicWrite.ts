import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

export interface StageFileOptions {
  /**
   * Runs against the fully written, checksum-verified staged content before the rename. Throw
   * to abort: the target file is left byte-for-byte untouched and the temp file is removed.
   *
   * Use this to keep a corrupt or incomplete generation from replacing a known-good file
   * (e.g. parse the staged TypeScript and throw on diagnostics).
   */
  validate?: (staged: string) => void | Promise<void>;
}

/**
 * Write `data` to `path` with verify-after-write atomic semantics: stage the
 * intended content to a sibling temp file, fsync it, verify its checksum
 * matches the intended content, optionally validate it, then atomically rename
 * it over the target. On POSIX the parent directory is fsynced after the
 * rename to persist the directory entry. Resolves with the SHA-256 checksum of
 * the written content.
 *
 * Every failure path removes the temp file and leaves the target untouched;
 * the only window in which the target changes is the atomic rename itself.
 */
export async function stageFileAtomic(
  path: string,
  data: string,
  opts: StageFileOptions = {},
): Promise<string> {
  const intended = sha256Hex(data);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  let committed = false;
  try {
    const fh = await open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(data, 'utf8');
      await fh.sync();
    } finally {
      // A close failure must not leave the temp file behind either. If writing already failed,
      // the finally above still runs; this close error is secondary to the write error.
      await fh.close().catch(() => undefined);
    }

    const staged = await readFile(tmp, 'utf8');
    if (sha256Hex(staged) !== intended) {
      throw new Error('atomicWrite: checksum mismatch after staging, target left untouched');
    }
    await opts.validate?.(staged);

    await rename(tmp, path);
    committed = true;
  } finally {
    if (!committed) await rm(tmp, { force: true }).catch(() => undefined);
  }

  if (process.platform !== 'win32') {
    try {
      const dh = await open(dir, 'r');
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    } catch {
      // Some platforms/filesystems refuse fsync on a directory handle; the rename is still atomic.
    }
  }

  return intended;
}

/** Backward-compatible name for {@link stageFileAtomic} without a validator. */
export async function writeFileAtomic(path: string, data: string): Promise<string> {
  return stageFileAtomic(path, data);
}
