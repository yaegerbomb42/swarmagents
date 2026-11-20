/**
 * Per-user async mutex for Test-Drive lifecycle transitions.
 *
 * The runtime control plane is in-process, so this is an in-process, per-user
 * promise chain: each user's start / keep / rollback / snapshot sequence runs
 * one at a time, and a later request waits for the previous one to finish.
 * That closes the TOCTOU window where two concurrent "start" requests both
 * pass the active-run check and both snapshot/start a drive, and where a
 * keep/rollback can race a concurrent start on the same pre-drive snapshot.
 */

const chains = new Map<string, Promise<unknown>>();

/** Run `fn` while holding the user's Test-Drive lock. */
export function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(userId) ?? Promise.resolve();
  const run = prev.then(fn);
  chains.set(userId, run);
  return run.finally(() => {
    if (chains.get(userId) === run) chains.delete(userId);
  });
}
