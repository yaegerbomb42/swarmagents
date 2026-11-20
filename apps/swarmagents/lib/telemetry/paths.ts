import os from "node:os";
import path from "node:path";

/**
 * Directory holding durable per-run telemetry logs. Production sets SWARM_HOME
 * to a mounted volume; the home-directory fallback keeps history across a
 * restart even when it is unset.
 */
let override: string | null | undefined;

export const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Test/deployment hook. Pass null to disable persistence. */
export function configureRunsDir(dir: string | null): void {
  override = dir;
}

export function getRunsDir(): string | null {
  if (override !== undefined) return override;
  const home = process.env.SWARM_HOME?.trim();
  if (home) return path.join(home, "runs");
  return path.join(os.homedir(), ".swarmagents", "runs");
}
