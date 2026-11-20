/**
 * Shared atomic file writer: temp file + fsync + rename.
 *
 * Several stores in this codebase already hand-rolled the same idiom
 * (write to `<file>.tmp.<pid>.<ts>`, then rename over the target), but each
 * copy omitted something — most never fsync, none validated the bytes before
 * the rename, and the temp-name schemes varied. This module is the one
 * place that idiom lives now; new writers should use it instead of
 * re-implementing the dance.
 *
 * Guarantees:
 *   - The target is replaced by a single rename, so a crash mid-write can
 *     never leave a torn file at the target path.
 *   - The temp file is fsynced before the rename, and the containing
 *     directory is fsynced (best effort) after it, so the new contents
 *     survive a power loss, not just a process crash.
 *   - An optional `validate` hook runs against the temp path before the
 *     rename: throw from it and the target is untouched (the temp file is
 *     removed and the error propagates).
 *   - On any failure the temp file is removed; the target is never left
 *     half-written.
 *
 * The temp file lives in the same directory as the target (a rename across
 * filesystems would not be atomic). `mode`, when given, is applied to the
 * temp file at creation, so the renamed target keeps it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export interface AtomicWriteOptions {
  /** File mode for the new file (e.g. 0o600). Defaults to the process default. */
  mode?: number;
  /** Text encoding for string contents. Defaults to "utf-8". */
  encoding?: BufferEncoding;
  /**
   * Optional hook run against the temp file after it is written and fsynced
   * but before the rename. Throw to abort the write (target untouched).
   * Use it to parse/validate the bytes (e.g. JSON.parse) before they go live.
   */
  validate?: (tmpPath: string) => void;
}

export interface AtomicWriteAsyncOptions {
  /** File mode for the new file (e.g. 0o600). Defaults to the process default. */
  mode?: number;
  /** Text encoding for string contents. Defaults to "utf-8". */
  encoding?: BufferEncoding;
  /** Async-capable form of {@link AtomicWriteOptions.validate}. */
  validate?: (tmpPath: string) => void | Promise<void>;
}

function tmpPathFor(file: string): string {
  return `${file}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
}

/** Best effort: a directory fsync is not supported everywhere. */
function fsyncDirBestEffort(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Directories cannot be fsynced on some filesystems; the rename itself
    // is still atomic, we just lose the power-loss durability guarantee.
  }
}

/** Best effort (async form of {@link fsyncDirBestEffort}). */
async function fsyncDirBestEffortAsync(dir: string): Promise<void> {
  try {
    const handle = await fs.promises.open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // See fsyncDirBestEffort.
  }
}

/**
 * Atomically write `contents` to `file` (sync). See the module docstring.
 * Throws on failure; the target is left untouched and no temp file remains.
 */
export function atomicWriteFile(
  file: string,
  contents: string | Buffer,
  options: AtomicWriteOptions = {},
): void {
  const tmp = tmpPathFor(file);
  try {
    const fd = fs.openSync(tmp, "w", options.mode ?? 0o666);
    try {
      fs.writeFileSync(fd, contents, { encoding: options.encoding ?? "utf-8" });
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    options.validate?.(tmp);
    fs.renameSync(tmp, file);
    fsyncDirBestEffort(path.dirname(file));
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // The temp file is best-effort cleanup; the original error wins.
    }
    throw err;
  }
}

/**
 * Atomically write `contents` to `file` (async). See the module docstring.
 * Rejects on failure; the target is left untouched and no temp file remains.
 */
export async function atomicWriteFileAsync(
  file: string,
  contents: string | Buffer,
  options: AtomicWriteAsyncOptions = {},
): Promise<void> {
  const tmp = tmpPathFor(file);
  try {
    const handle = await fs.promises.open(tmp, "w", options.mode ?? 0o666);
    try {
      await handle.writeFile(contents, { encoding: options.encoding ?? "utf-8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.validate?.(tmp);
    await fs.promises.rename(tmp, file);
    await fsyncDirBestEffortAsync(path.dirname(file));
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
