import fs from "node:fs";
import path from "node:path";
import { resolveStorageDir } from "../board/store";

/**
 * Concurrency locks for board-agent chat turns.
 *
 * (1) Provides an in-process AsyncLock mutex per conversation to serialize turns.
 * (2) Uses a file-based lock helper (withTurnFileLock) to ensure cross-worker /
 * multi-process safety if the server ever scales beyond one worker.
 */

export class AsyncLock {
  private promise: Promise<void> = Promise.resolve();
  async acquire<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = this.promise;
    let resolve!: () => void;
    this.promise = new Promise<void>((res) => {
      resolve = res;
    });
    await release;
    try {
      return await fn();
    } finally {
      resolve();
    }
  }
}

const globals = globalThis as typeof globalThis & {
  __swarmBoardAgentChatLocks?: Map<string, AsyncLock>;
};

const chatLocks = (globals.__swarmBoardAgentChatLocks ??= new Map<string, AsyncLock>());

export function getTurnLock(key: string): AsyncLock {
  let lock = chatLocks.get(key);
  if (!lock) {
    lock = new AsyncLock();
    chatLocks.set(key, lock);
  }
  return lock;
}

/**
 * File lock acquisition with retry and stale lock recovery.
 */
function lockFilePath(key: string): string {
  const safeKey = Buffer.from(key, "utf8").toString("base64url");
  const lockDir = path.join(resolveStorageDir(), "locks", "board-agent-chat");
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  return path.join(lockDir, `${safeKey}.lock`);
}

export async function withTurnLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const inProcessLock = getTurnLock(key);
  return inProcessLock.acquire(async () => {
    const file = lockFilePath(key);
    let acquired = false;
    const start = Date.now();
    const timeoutMs = 60000;
    const staleMs = 120000;

    while (!acquired) {
      try {
        const fd = fs.openSync(file, "wx");
        fs.writeFileSync(fd, `${process.pid}\n${Date.now()}`);
        fs.closeSync(fd);
        acquired = true;
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === "EEXIST") {
          // Check for stale lock
          try {
            const stat = fs.statSync(file);
            if (Date.now() - stat.mtimeMs > staleMs) {
              fs.unlinkSync(file);
              continue;
            }
          } catch {
            // Lock was removed in the meantime, retry
            continue;
          }
          if (Date.now() - start > timeoutMs) {
            throw new Error(`Timeout acquiring turn file lock for ${key}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        } else {
          // Storage or filesystem issue; do not crash, let the in-process lock proceed
          break;
        }
      }
    }

    try {
      return await fn();
    } finally {
      if (acquired) {
        try {
          fs.unlinkSync(file);
        } catch {
          // ignore unlink error
        }
      }
    }
  });
}
