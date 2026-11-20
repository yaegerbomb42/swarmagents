/**
 * Dependency slices for codebase strikes.
 *
 * A strike is a scoped run against one hotspot: the agent gets the target
 * file (or top-level module) plus its direct imports and its direct
 * importers — enough context to refactor, test or explain it, and nothing
 * else. The slice is a manifest, not file contents: each file is one line
 * (purpose, exports, lines, complexity, coverage), so it stays inside a
 * small token budget and the run reads the files itself inside the VM.
 *
 * Everything here is pure: it takes a map and returns text, so it can be
 * unit tested without a VM.
 */

import { estimateTokens, truncateToTokenBudget } from "./tokens";
import type { CodebaseFileInfo, CodebaseMap } from "./types";

/** The actions a strike can take on a slice. */
export const STRIKE_ACTIONS = ["refactor", "tests", "explain"] as const;
export type StrikeAction = (typeof STRIKE_ACTIONS)[number];

/** True when the value is one of the strike actions. */
export function isStrikeAction(value: unknown): value is StrikeAction {
  return typeof value === "string" && (STRIKE_ACTIONS as readonly string[]).includes(value);
}

export interface DependencySlice {
  path: string;
  kind: "file" | "module";
  /** The files actually present in `text`, in the order they appear there. */
  files: string[];
  text: string;
  tokenEstimate: number;
}

export interface SliceTarget {
  path: string;
  kind: "file" | "module";
  /** Every file the target covers (before the token budget is applied). */
  files: string[];
}

/**
 * Normalize a caller-supplied path to a repo-relative posix path. Returns
 * null for anything that cannot be inside the repo (absolute, escaping,
 * empty). Matching a map entry is a separate step.
 */
export function normalizeSlicePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim().replace(/\\/g, "/");
  while (value.startsWith("./")) value = value.slice(2);
  value = value.replace(/\/+$/, "");
  if (!value) return null;
  if (value.startsWith("/") || value === ".." || value.startsWith("../")) return null;
  if (value.split("/").includes("..")) return null;
  return value;
}

/**
 * Resolve a path against a map: an exact file, or a top-level module
 * (a directory, or a single top-level file module). Anything else is null —
 * the caller turns that into a 404 and never lets the path escape the repo.
 */
export function resolveSliceTarget(map: CodebaseMap, rawPath: unknown): SliceTarget | null {
  const path = normalizeSlicePath(rawPath);
  if (!path) return null;
  const byPath = new Map(map.files.map((file) => [file.path, file]));
  if (byPath.has(path)) return { path, kind: "file", files: [path] };
  const mod = (map.topLevelModules ?? []).find((m) => m.path === path);
  if (!mod) return null;
  if (mod.kind === "file") return { path, kind: "module", files: [path] };
  const files = map.files
    .filter((file) => file.path.startsWith(`${path}/`))
    .map((file) => file.path)
    .sort((a, b) => a.localeCompare(b));
  return { path, kind: "module", files };
}

/** One slice line for a file: purpose, exports, size, complexity, coverage. */
function describeFile(file: CodebaseFileInfo): string {
  const bits: string[] = [];
  if (file.lines !== undefined) bits.push(`${file.lines} lines`);
  if (file.language) bits.push(file.language);
  if (file.exports?.length) bits.push(`exports: ${file.exports.slice(0, 6).join(", ")}`);
  if (file.complexity !== undefined) bits.push(`complexity ${file.complexity}`);
  bits.push(
    file.coveragePct === null || file.coveragePct === undefined
      ? "coverage unknown"
      : `coverage ${Math.round(file.coveragePct)}%`,
  );
  if (file.churn90d) bits.push(`churn90d ${file.churn90d}`);
  if (file.fanIn) bits.push(`fan-in ${file.fanIn}`);
  const purpose = file.purpose ? ` — ${file.purpose}` : "";
  return `- ${file.path}${purpose} (${bits.join(", ")})`;
}

/**
 * Build the dependency slice for a file or top-level module: the target,
 * its direct imports and its direct importers (fan-in), token-bounded.
 * The target files always come first, so a tight budget cuts importers
 * before it cuts the target itself. Throws when the path is not in the map.
 */
export function buildDependencySlice(
  map: CodebaseMap,
  rawPath: string,
  budget = 4000,
): DependencySlice {
  const target = resolveSliceTarget(map, rawPath);
  if (!target) throw new Error(`Path is not a file or top-level module in this codebase map: ${rawPath}`);

  const byPath = new Map(map.files.map((file) => [file.path, file]));
  const importers = new Map<string, string[]>();
  for (const file of map.files) {
    for (const imported of file.imports ?? []) {
      const list = importers.get(imported) ?? [];
      list.push(file.path);
      importers.set(imported, list);
    }
  }

  // Target files, then their direct imports, then their direct importers.
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (paths: string[]) => {
    for (const p of [...paths].sort((a, b) => a.localeCompare(b))) {
      if (!seen.has(p) && byPath.has(p)) {
        seen.add(p);
        ordered.push(p);
      }
    }
  };
  add(target.files);
  const imports: string[] = [];
  for (const file of target.files) imports.push(...(byPath.get(file)?.imports ?? []));
  add(imports);
  const fans: string[] = [];
  for (const file of target.files) fans.push(...(importers.get(file) ?? []));
  add(fans);

  const header = [
    `# Dependency slice: ${target.path} (${target.kind})`,
    `Repository: ${map.repoName}`,
    `Target files: ${target.files.length}; direct imports + direct importers included where the budget allows.`,
    "",
    "## Files",
  ].join("\n");

  const included: string[] = [];
  let text = header;
  for (const path of ordered) {
    const file = byPath.get(path);
    if (!file) continue;
    const line = `\n${describeFile(file)}`;
    if (included.length > 0 && estimateTokens(text + line) > budget) break;
    text += line;
    included.push(path);
  }
  // Defensive: the header alone could exceed a tiny budget.
  if (estimateTokens(text) > budget) {
    const cut = truncateToTokenBudget(text, budget);
    text = cut.text;
    const kept = included.filter((path) => text.includes(`- ${path} `) || text.includes(`- ${path} (`));
    return { path: target.path, kind: target.kind, files: kept, text, tokenEstimate: cut.tokenEstimate };
  }
  return { path: target.path, kind: target.kind, files: included, text, tokenEstimate: estimateTokens(text) };
}

/** The coverage figure for a strike target: a file's own, or a module mean. */
export function targetCoveragePct(
  map: CodebaseMap,
  target: SliceTarget,
): number | null {
  const values = target.files
    .map((path) => map.files.find((file) => file.path === path)?.coveragePct)
    .filter((pct): pct is number => typeof pct === "number");
  if (!values.length) return null;
  return values.reduce((sum, pct) => sum + pct, 0) / values.length;
}

/**
 * Compose the scoped run prompt for a strike action. The prompt names the
 * slice boundary explicitly: the agent works only inside the listed files.
 *
 * For `explain`, `lensFindings` carries the architecture lens diagram the
 * server already ran over the slice (see lib/codebase/strike-lens.ts): the
 * agent verifies and explains it instead of being told to run the lens
 * itself. Without findings the prompt keeps the old instruction as fallback.
 */
export function composeStrikePrompt(
  action: StrikeAction,
  slice: DependencySlice,
  target?: { complexity?: number; coveragePct?: number | null; lensFindings?: string },
): string {
  const scope = `Work only inside the listed slice; do not touch files outside it. If a change needs a file outside the slice, say so in your summary instead of editing it.`;
  const head = (title: string, body: string) =>
    `${title}\n\n${body}\n\n${slice.text}\n`;

  switch (action) {
    case "refactor": {
      const complexity =
        target?.complexity !== undefined
          ? ` Its branch-count complexity is ${target.complexity} — bring that down where doing so clarifies the code, without changing behaviour.`
          : "";
      return head(
        `Refactor this hotspot for clarity and lower complexity.`,
        `Hotspot: ${slice.path} (${slice.kind}).${complexity} Keep behaviour identical: do not change public exports, and keep the existing test command passing. Prefer small, named extractions over rewrites. ${scope} Leave a short summary of what changed and why.`,
      );
    }
    case "tests": {
      const coverage =
        target?.coveragePct === null || target?.coveragePct === undefined
          ? "No coverage data was found for this module — treat every file in the slice as untested and cover the riskiest behaviour first."
          : `Measured line coverage for this module is ${target.coveragePct.toFixed(1)}% — aim the new tests at the least-covered behaviour in the slice.`;
      return head(
        `Write the missing tests for this module.`,
        `Module: ${slice.path} (${slice.kind}). ${coverage} Put the tests where this repository's existing tests live and follow its test framework and conventions. ${scope} Run the new tests and report the result.`,
      );
    }
    case "explain": {
      const lensSection = target?.lensFindings
        ? `Module: ${slice.path} (${slice.kind}). The architecture lens already analysed this slice server-side and produced the diagram below — use it as the starting point for your explanation: verify each edge against the listed files, correct anything it got wrong, and explain what the module is for, how its files fit together, what depends on it and what it depends on, and where the complexity lives. Ground every claim in the listed files — do not invent behaviour you cannot see there.\n\nArchitecture lens findings:\n${target.lensFindings}`
        : `Module: ${slice.path} (${slice.kind}). Use the architecture lens on the slice below: what the module is for, how its files fit together, what depends on it and what it depends on, and where the complexity lives. Ground every claim in the listed files — do not invent behaviour you cannot see there.`;
      return head(`Explain this module's architecture.`, `${lensSection} ${scope}`);
    }
  }
}
