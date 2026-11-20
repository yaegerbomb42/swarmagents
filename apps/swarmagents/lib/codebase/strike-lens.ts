/**
 * "Explain via Lens" — the architecture lens, run server-side for a strike.
 *
 * Today the strike prompt for `action: "explain"` only tells the agent to
 * "use the architecture lens" on the slice. This module runs that lens for
 * real before the run starts: the slice manifest plus its import edges go
 * through the same `runLens` machinery POST /api/lenses uses (cheapest
 * capable model, per-user cache), and the returned mermaid diagram rides in
 * the run's prompt and in the strike response.
 *
 * Best effort by design: a lens failure (no provider configured, a provider
 * error, a timeout) returns null and the strike proceeds with the old
 * prompt wording — the lens must never block a run.
 */

import { runLens } from "../lenses/run";
import type { LensResult } from "../lenses/types";
import type { CodebaseMap } from "./types";
import type { DependencySlice } from "./slice";

/** What the strike route returns (and embeds) when the lens ran. */
export interface StrikeLensFindings {
  lens: "architecture";
  /** The lens answer: a mermaid diagram of the module. */
  text: string;
  /** Provider that served the call (never a key). */
  provider: string;
  /** Model that served the call. */
  model: string;
  /** Estimated cost in USD; null when the price is unknown. */
  costUsd: number | null;
  /** True when the answer came from the per-user lens cache. */
  cached: boolean;
}

/** Bound on how long the strike route waits for the lens. */
export const STRIKE_LENS_TIMEOUT_MS = 60_000;

/** Injectable lens runner (tests swap in a fake; production uses runLens). */
export type StrikeLensRunner = (input: {
  userId: string;
  lens: "architecture";
  message: string;
}) => Promise<LensResult>;

let runnerForTesting: StrikeLensRunner | null = null;

export function setStrikeLensRunnerForTesting(runner: StrikeLensRunner | null): void {
  runnerForTesting = runner;
}

/**
 * The message the architecture lens reads: the module, its slice manifest
 * (purpose/exports per file) and the import edges inside the slice, so the
 * diagram it draws is grounded in real dependencies.
 */
export function buildExplainLensMessage(slice: DependencySlice, map: CodebaseMap): string {
  const inSlice = new Set(slice.files);
  const byPath = new Map(map.files.map((file) => [file.path, file]));
  const edges: string[] = [];
  for (const filePath of slice.files) {
    const imports = (byPath.get(filePath)?.imports ?? []).filter((imp) => inSlice.has(imp));
    if (imports.length > 0) edges.push(`- ${filePath} imports ${imports.join(", ")}`);
  }
  return [
    `Architecture of module ${slice.path} (${slice.kind}) in repository ${map.repoName}.`,
    "Dependency slice (one line per file: purpose, exports, size, complexity, coverage):",
    slice.text,
    edges.length > 0
      ? `Import edges inside the slice:\n${edges.join("\n")}`
      : "No imports between the slice files were found.",
  ].join("\n\n");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Run the architecture lens over the dependency slice. Returns the findings,
 * or null when the lens could not run (no provider, provider error, timeout)
 * — the caller proceeds without them.
 */
export async function runExplainLens(
  userId: string,
  slice: DependencySlice,
  map: CodebaseMap,
  opts: { timeoutMs?: number } = {},
): Promise<StrikeLensFindings | null> {
  const timeoutMs = opts.timeoutMs ?? STRIKE_LENS_TIMEOUT_MS;
  const run: StrikeLensRunner =
    runnerForTesting ??
    ((input) => runLens({ userId: input.userId, lens: input.lens, message: input.message }));
  try {
    const result = await withTimeout(
      run({ userId, lens: "architecture", message: buildExplainLensMessage(slice, map) }),
      timeoutMs,
    );
    if (!result) {
      console.error(`[strike-lens] architecture lens timed out after ${timeoutMs}ms`);
      return null;
    }
    return {
      lens: "architecture",
      text: result.text,
      provider: result.provider,
      model: result.model,
      costUsd: result.costUsd,
      cached: result.cached,
    };
  } catch (error) {
    console.error("[strike-lens] architecture lens failed:", error instanceof Error ? error.message : error);
    return null;
  }
}
