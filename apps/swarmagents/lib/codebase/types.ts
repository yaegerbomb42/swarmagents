/**
 * Types for the codebase map.
 *
 * A "codebase map" is built for one repository inside a user's VM workspace
 * and answers two questions:
 *
 *   1. What is this codebase?  -> the context pack (a compact, token-bounded
 *      summary of languages, entry points, commands, modules and key files).
 *   2. Where is the heat?       -> the heatmap (per-file churn x size x
 *      fan-in x the files this account's agent touched before).
 *
 * The scan is produced by a small program that runs *inside the user's VM*
 * (lib/codebase/vm-analyzer-source.ts). Everything that decides ranking,
 * budgeting or wording happens here on the server, so the same rules apply to
 * every repo and can be unit tested without a VM.
 */

/** One file as seen by the scanner: repo-relative, posix paths. */
export interface CodebaseScannedFile {
  path: string;
  bytes: number;
  lines?: number;
  language?: string;
  /** Exported symbol names (empty when the file exports nothing). */
  exports?: string[];
  /** Raw import specifiers as written in the file. */
  imports?: string[];
  /** The first few hundred characters of the file, used to describe it. */
  head?: string;
  /**
   * Branch-count complexity: how many branching constructs (`if`, `for`,
   * `while`, `switch`, `case`, `catch`, ternary `?`, `&&`, `||`, `??`) the
   * analyzer counted in the file. Omitted when the file was not parsed
   * (too large, binary), so unknown — not zero.
   */
  complexity?: number;
}

/** The `package.json` facts the pack reports (scripts + tool deps). */
export interface CodebasePackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
}

/** Raw scanner output for one repository. */
export interface CodebaseScan {
  /** Absolute path of the repository root (inside the VM). */
  repoRoot: string;
  repoName: string;
  repoHash: string;
  generatedAt: string;
  /** HEAD commit of the repository, when it is a git checkout. */
  gitHead?: string;
  files: CodebaseScannedFile[];
  /** path -> lines added+deleted in the last 90 days. */
  churn: Record<string, number>;
  /**
   * path -> lines covered percent (0..100), read from a coverage artifact
   * (`coverage/coverage-summary.json`, else `coverage/coverage-final.json`)
   * when the repository has one. Keys are absolute or repo-relative paths
   * as the artifact wrote them; the map builder relativizes them. Absent
   * (or empty) when the repository has no coverage artifact.
   */
  coverage?: Record<string, number>;
  packageJson?: CodebasePackageJson;
  /** Every package.json found in the repository (monorepos have many). */
  packageFiles?: Array<CodebasePackageJson & { path: string }>;
  /** Lock files seen in the repository (they say which package manager to use). */
  lockFiles?: string[];
  /** True when the scanner hit a file or byte cap and stopped early. */
  truncated?: boolean;
}

export interface CodebaseFileInfo {
  path: string; // repo-relative, posix
  bytes: number;
  lines?: number;
  language?: string;
  purpose?: string;
  exports?: string[];
  /** Resolved repo-relative import targets (direct imports of this file). */
  imports?: string[];
  fanIn: number;
  churn90d: number;
  agentTouches: number;
  heat: number;
  lastModifiedMs?: number;
  /** Branch-count complexity; omitted when the scanner never parsed the file. */
  complexity?: number;
  /** Lines covered, 0..100; null when the repository has no coverage for this file. */
  coveragePct?: number | null;
}

export interface CodebaseModuleInfo {
  path: string; // top-level dir or file
  kind: "dir" | "file";
  purpose: string;
  files: number;
  bytes: number;
}

export interface CodebaseConventions {
  testFramework?: string;
  lint?: string;
  format?: string;
  packageManager?: string;
  notes?: string[];
}

export interface CodebaseContextPack {
  repoRoot: string;
  repoName: string;
  repoHash: string;
  generatedAt: string;
  gitHead?: string;
  languages: Record<string, number>;
  entryPoints: string[];
  buildCommands: string[];
  testCommands: string[];
  topLevelModules: CodebaseModuleInfo[];
  keyFiles: Array<{
    path: string;
    purpose?: string;
    exports?: string[];
    fanIn: number;
  }>;
  conventions: CodebaseConventions;
  tokenEstimate: number;
  text: string;
}

export interface CodebaseHeatmapEntry {
  path: string;
  churn90d: number;
  bytes: number;
  fanIn: number;
  agentTouches: number;
  heat: number;
  /** Branch-count complexity; omitted when the scanner never parsed the file. */
  complexity?: number;
  /** Lines covered, 0..100; null when the repository has no coverage for this file. */
  coveragePct?: number | null;
}

export interface CodebaseMap {
  version: 1;
  repoRoot: string;
  repoName: string;
  repoHash: string;
  generatedAt: string;
  gitHead?: string;
  buildMs: number;
  files: CodebaseFileInfo[];
  topLevelModules: CodebaseModuleInfo[];
  languages: Record<string, number>;
  entryPoints: string[];
  buildCommands: string[];
  testCommands: string[];
  conventions: CodebaseConventions;
  contextPack: CodebaseContextPack;
  heatmap: CodebaseHeatmapEntry[];
}

/** One repository the account can pick from its VM workspace. */
export interface CodebaseRepoOption {
  /** Workspace-relative path ("" is the workspace root itself). */
  repo: string;
  /** Absolute path inside the VM. */
  repoRoot: string;
  name: string;
}

/**
 * The port the map builder uses to reach a repository. Implemented by the
 * VM scanner (runs the analyzer inside the user's VM) and by the local
 * scanner (runs the same analyzer with the host's node).
 */
export interface CodebaseScanner {
  /** Scan one repository. Returns null when the path is not a directory. */
  scan(
    userId: string,
    repoRoot: string,
    options?: { sinceHead?: string },
  ): Promise<CodebaseScan | null>;
  /** Current HEAD of the repository, or undefined when it is not a checkout. */
  head(userId: string, repoRoot: string): Promise<string | undefined>;
  /** Persist the finished map inside the VM (map.json + context-pack.md). */
  publish(userId: string, repoRoot: string, map: CodebaseMap): Promise<void>;
  /** Read back a map that was published before (no rebuild). */
  readMap(userId: string, repoRoot: string): Promise<CodebaseMap | null>;
  /** Repositories available in the workspace (git checkouts). */
  listRepos(userId: string): Promise<CodebaseRepoOption[]>;
  /** The repository the account picked (null when it never picked one). */
  selectedRepo(userId: string): Promise<string | null>;
  /** Remember which repository the account picked. */
  selectRepo(userId: string, repoRoot: string): Promise<void>;
}

export interface BuildCodebaseMapOptions {
  repoRoot: string;
  tokenBudget?: number;
  nowMs?: number;
  /** path -> how many times this account's agent touched the file. */
  agentTouchesByPath?: Record<string, number>;
}
