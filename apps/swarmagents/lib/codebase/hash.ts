import { createHash } from "node:crypto";
import path from "node:path";

export function repoHashForRoot(repoRoot: string): string {
  const normalized = path.resolve(repoRoot);
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

export function repoNameForRoot(repoRoot: string): string {
  return path.basename(path.resolve(repoRoot)) || "repo";
}
