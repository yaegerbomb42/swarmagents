/**
 * Oracle gate: apply each candidate diff in a scratch copy, run tsc + lint
 * + the affected tests there, and land only the patches that pass.
 *
 * Today a run's diff lands whether or not it works. With the gate:
 *   1. Each candidate is checked for unsafe paths (absolute, `..`, .git).
 *   2. A scratch worktree of the repo (HEAD + uncommitted state) is made
 *      and the candidate is applied there (`git apply`).
 *   3. The checks run in order — tsc, lint on the changed files, the
 *      affected tests — stopping at the first failure.
 *   4. Passing candidates land in the real tree (`git apply --check` first,
 *      so a tree that moved underneath is a conflict, not a half-apply).
 *      Failed ones are evicted: nothing of them touches the real tree, and
 *      the retry gets only the diagnostic plus the named symbol's
 *      definition (see ./retry.ts).
 *
 * Modes:
 *   - "best" (default, best-of-N): evaluate every candidate, land the
 *     passing one with the smallest churn (ties: input order).
 *   - "first": land the first passing candidate, skip the rest.
 *   - "all": candidates are sequential patches; each is evaluated on top
 *     of the ones already landed and lands if it passes.
 *
 * The gate is fail-closed: an infrastructure error (scratch cannot be
 * made, exec throws) marks the candidate "error" and it does not land.
 * It never throws for a candidate outcome.
 *
 * All I/O goes through the injected exec (the run's VM exec in
 * production). Diagnostics are redacted before they are logged/returned.
 */

import { posix as path } from "node:path";
import { findAffectedTests, isTestFile, relativeImports, resolveSpecifier } from "./affected";
import { countChurn, parsePatchFiles, unsafePatchPaths, type PatchFile } from "./diff";
import { execWithTimeout, writeFileViaExec, type OracleExec } from "./exec";
import { buildRetryContext, diagnosticLocation, extractDiagnostic, identifierAt } from "./retry";
import { createScratch, type Scratch } from "./scratch";

export interface OracleCandidate {
  id: string;
  /** Unified diff, repo-relative paths (`git diff` output). */
  diff: string;
}

export interface OracleCheckContext {
  /** Absolute project directory inside the scratch (the check's cwd). */
  cwd: string;
  /** Absolute scratch root. */
  scratchDir: string;
  /** Project-relative files the patch adds/modifies (deleted excluded). */
  changedFiles: string[];
  /** Project-relative affected test files. */
  affectedTests: string[];
}

export interface OracleCheck {
  name: string;
  /** argv to run, or null to skip the check for this candidate. */
  command(ctx: OracleCheckContext): string[] | null;
  timeoutMs?: number;
}

export interface CheckRun {
  name: string;
  status: "passed" | "failed" | "skipped";
  exitCode?: number;
  durationMs: number;
}

export type CandidateVerdict =
  | { id: string; status: "passed"; landed: boolean; churn: number; checks: CheckRun[]; note?: string }
  | { id: string; status: "rejected"; stage: string; diagnostic: string; retryContext: string; checks: CheckRun[] }
  | { id: string; status: "error"; stage: string; diagnostic: string; checks: CheckRun[] }
  | { id: string; status: "skipped"; checks: CheckRun[] };

export interface OracleReport {
  verdicts: CandidateVerdict[];
  /** Ids of candidates that landed in the real tree, in landing order. */
  landed: string[];
  rejected: number;
  total: number;
  /** "oracle: R/N candidates rejected" (+ landed id). */
  summary: string;
  /**
   * Retry context for the next attempt when nothing landed: the first
   * rejection's diagnostic plus the symbol definition. Undefined otherwise.
   */
  retryContext?: string;
}

export interface OracleGateOptions {
  /** Absolute git repository root (the real tree). */
  repoRoot: string;
  /** Repo-relative project directory where checks run. Default ".". */
  projectDir?: string;
  checks?: OracleCheck[];
  mode?: "best" | "first" | "all";
  /** Repo-relative dirs symlinked into each scratch (e.g. node_modules). */
  linkDirs?: string[];
  scratchRoot?: string;
  /** Per-check timeout (ms). Default 5 minutes. */
  checkTimeoutMs?: number;
  maxDiagnosticChars?: number;
  /** When set, landed patches are also committed with this message. */
  commitMessage?: string;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const LINTABLE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * Default checks for a TypeScript project like apps/swarmagents: tsc over
 * the project, eslint on the changed files, tsx --test on the affected
 * tests. `testEnv` is prefixed via env(1) (e.g. SWARM_HOME).
 */
export function defaultOracleChecks(opts: { testEnv?: Record<string, string> } = {}): OracleCheck[] {
  const envPrefix = Object.entries(opts.testEnv ?? {}).map(([k, v]) => `${k}=${v}`);
  return [
    { name: "tsc", command: () => ["npx", "--no-install", "tsc", "--noEmit", "--incremental", "false"] },
    {
      name: "lint",
      command: (ctx) => {
        const files = ctx.changedFiles.filter((f) => LINTABLE_RE.test(f));
        return files.length ? ["npx", "--no-install", "eslint", "--no-warn-ignored", "--", ...files] : null;
      },
    },
    {
      name: "tests",
      command: (ctx) =>
        ctx.affectedTests.length
          ? [
              ...(envPrefix.length ? ["env", ...envPrefix] : []),
              "npx",
              "--no-install",
              "tsx",
              "--test",
              "--test-concurrency=4",
              ...ctx.affectedTests,
            ]
          : null,
    },
  ];
}

/** Project-relative view of the patch's files (outside the project dropped). */
function projectFiles(files: PatchFile[], projectDir: string): PatchFile[] {
  const prefix = projectDir === "." || projectDir === "" ? "" : `${projectDir.replace(/\/+$/, "")}/`;
  return files
    .filter((f) => !prefix || f.path.startsWith(prefix))
    .map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
}

function spellings(stem: string): string[] {
  return stem.startsWith("..") || stem.includes("/../")
    ? []
    : ["ts", "tsx", "mts", "cts"].flatMap((ext) => [`${stem}.${ext}`, `${stem}/index.${ext}`]);
}

async function readText(exec: OracleExec, file: string): Promise<string | undefined> {
  try {
    const res = await exec(["cat", "--", file]);
    return res.exitCode === 0 ? res.stdout : undefined;
  } catch {
    return undefined;
  }
}

export class OracleGate {
  private readonly exec: OracleExec;
  private readonly opts: Required<Pick<OracleGateOptions, "projectDir" | "mode" | "checkTimeoutMs" | "maxDiagnosticChars">> &
    OracleGateOptions;

  constructor(exec: OracleExec, options: OracleGateOptions) {
    this.exec = exec;
    this.opts = {
      projectDir: ".",
      mode: "best",
      checkTimeoutMs: DEFAULT_TIMEOUT_MS,
      maxDiagnosticChars: 2000,
      ...options,
    };
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  async run(candidates: OracleCandidate[]): Promise<OracleReport> {
    const verdicts: CandidateVerdict[] = [];
    const landed: string[] = [];
    const passed: { id: string; diff: string; churn: number }[] = [];

    for (const candidate of candidates) {
      if (this.opts.signal?.aborted) {
        verdicts.push({ id: candidate.id, status: "skipped", checks: [] });
        continue;
      }
      if (this.opts.mode === "first" && landed.length > 0) {
        verdicts.push({ id: candidate.id, status: "skipped", checks: [] });
        continue;
      }
      let verdict = await this.evaluate(candidate);
      if (verdict.status === "passed") {
        if (this.opts.mode === "best") passed.push({ id: candidate.id, diff: candidate.diff, churn: verdict.churn });
        else verdict = await this.landOrConflict(candidate, verdict, landed);
      }
      verdicts.push(verdict);
    }

    if (this.opts.mode === "best" && passed.length > 0) {
      const winner = [...passed].sort((a, b) => a.churn - b.churn)[0];
      for (let i = 0; i < verdicts.length; i++) {
        const v = verdicts[i];
        if (v.status !== "passed") continue;
        if (v.id === winner.id) verdicts[i] = await this.landOrConflict(winner, v, landed);
        else verdicts[i] = { ...v, note: `passed but not landed: ${winner.id} has less churn` };
      }
    }

    const rejected = verdicts.filter((v) => v.status === "rejected" || v.status === "error").length;
    const summary =
      `oracle: ${rejected}/${candidates.length} candidates rejected` +
      (landed.length ? `; landed ${landed.join(", ")}` : "; nothing landed");
    this.log(summary);

    const firstRejection = verdicts.find((v) => v.status === "rejected");
    return {
      verdicts,
      landed,
      rejected,
      total: candidates.length,
      summary,
      retryContext: landed.length === 0 && firstRejection?.status === "rejected" ? firstRejection.retryContext : undefined,
    };
  }

  /** Land a passing candidate; it becomes an error when the real tree no longer accepts it. */
  private async landOrConflict(
    candidate: { id: string; diff: string },
    verdict: Extract<CandidateVerdict, { status: "passed" }>,
    landed: string[],
  ): Promise<CandidateVerdict> {
    try {
      await this.land(candidate);
      landed.push(candidate.id);
      this.log(`oracle: candidate ${candidate.id} passed and landed`);
      return { ...verdict, landed: true };
    } catch (error) {
      const diagnostic = extractDiagnostic(error instanceof Error ? error.message : String(error), this.opts.maxDiagnosticChars);
      this.log(`oracle: candidate ${candidate.id} passed but could not land: ${diagnostic.split("\n")[0]}`);
      return { id: candidate.id, status: "error", stage: "land", diagnostic, checks: verdict.checks };
    }
  }

  private async evaluate(candidate: OracleCandidate): Promise<CandidateVerdict> {
    const checks: CheckRun[] = [];
    const files = parsePatchFiles(candidate.diff);
    let scratch: Scratch | null = null;
    const reject = async (stage: string, raw: string): Promise<CandidateVerdict> => {
      const diagnostic = extractDiagnostic(raw, this.opts.maxDiagnosticChars);
      this.log(`oracle: candidate ${candidate.id} rejected at ${stage}: ${diagnostic.split("\n")[0] ?? ""}`);
      const retryContext = buildRetryContext({
        stage,
        diagnostic,
        locationSymbol: await this.locationSymbol(scratch, diagnostic),
        files: await this.definitionSources(files),
      });
      return { id: candidate.id, status: "rejected", stage, diagnostic, retryContext, checks };
    };

    if (files.length === 0) return reject("parse", "patch touches no files (empty or malformed diff)");
    const unsafe = unsafePatchPaths(files);
    if (unsafe.length) return reject("safety", `patch touches unsafe paths: ${unsafe.join(", ")}`);

    try {
      scratch = await createScratch(this.exec, {
        repoRoot: this.opts.repoRoot,
        scratchRoot: this.opts.scratchRoot,
        linkDirs: this.opts.linkDirs,
      });
      const patchFile = `${scratch.dir}.candidate.patch`;
      await writeFileViaExec(this.exec, patchFile, candidate.diff);
      const applied = await this.exec(["git", "-C", scratch.dir, "apply", "--whitespace=nowarn", patchFile]);
      await this.exec(["rm", "-f", patchFile]);
      if (applied.exitCode !== 0) return await reject("apply", applied.stderr || applied.stdout);

      const cwd = path.join(scratch.dir, this.opts.projectDir);
      const changed = projectFiles(files, this.opts.projectDir);
      const ctx: OracleCheckContext = {
        cwd,
        scratchDir: scratch.dir,
        changedFiles: changed.filter((f) => f.status !== "D").map((f) => f.path),
        affectedTests: await this.affectedTests(cwd, changed),
      };

      for (const check of this.opts.checks ?? defaultOracleChecks()) {
        const argv = check.command(ctx);
        if (!argv) {
          checks.push({ name: check.name, status: "skipped", durationMs: 0 });
          continue;
        }
        const started = Date.now();
        const res = await execWithTimeout(this.exec, argv, {
          cwd,
          timeoutMs: check.timeoutMs ?? this.opts.checkTimeoutMs,
          signal: this.opts.signal,
        });
        const durationMs = Date.now() - started;
        if (res.exitCode !== 0) {
          checks.push({ name: check.name, status: "failed", exitCode: res.exitCode, durationMs });
          return await reject(check.name, `${res.stdout}\n${res.stderr}`);
        }
        checks.push({ name: check.name, status: "passed", exitCode: 0, durationMs });
      }
      return { id: candidate.id, status: "passed", landed: false, churn: countChurn(candidate.diff), checks };
    } catch (error) {
      const diagnostic = extractDiagnostic(error instanceof Error ? error.message : String(error), this.opts.maxDiagnosticChars);
      this.log(`oracle: candidate ${candidate.id} errored (not landed): ${diagnostic.split("\n")[0]}`);
      return { id: candidate.id, status: "error", stage: scratch ? "check" : "scratch", diagnostic, checks };
    } finally {
      await scratch?.dispose();
    }
  }

  /** Affected tests inside the scratch project after the patch. */
  private async affectedTests(cwd: string, changed: PatchFile[]): Promise<string[]> {
    const listed = await this.exec(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd });
    if (listed.exitCode !== 0) return changed.filter((f) => isTestFile(f.path) && f.status !== "D").map((f) => f.path);
    const allTests = listed.stdout.split("\0").filter(Boolean).filter(isTestFile);
    // Only read tests that could be affected: their path or their text
    // mentions a changed module's basename (one batched grep, not one per file).
    // For an `index.*` change, tests usually import the parent directory
    // (`../dir`), so include that basename in the prefilter as well.
    const names = new Set<string>();
    for (const f of changed) {
      const base = path.basename(f.path).replace(/\.[^.]+$/, "").replace(/\.(test|spec)$/, "");
      if (base) names.add(base);
      if (base === "index") {
        const dir = path.basename(path.dirname(f.path));
        if (dir && dir !== ".") names.add(dir);
      }
    }
    const needles = [...names];
    const maybe = new Set(allTests.filter((t) => needles.some((n) => t.includes(n))));
    const rest = allTests.filter((t) => !maybe.has(t));
    for (const hit of await this.grepNeedles(rest, needles, cwd)) maybe.add(hit);
    const contents = new Map<string, string>();
    await this.readContents([...maybe], cwd, contents);

    // Transitive selection needs the source modules the candidate tests
    // import. Read them (bounded, breadth-first) so findAffectedTests can
    // follow test → module → changed module chains.
    let next = [...new Set([...contents].flatMap(([test, text]) =>
      relativeImports(text).flatMap((spec) => spellings(resolveSpecifier(test, spec))),
    ))];
    let budget = 100;
    for (let hop = 0; hop < 2 && next.length > 0 && budget > 0; hop += 1) {
      const { next: following, budget: remaining } = await this.readFrontier(next, cwd, contents, budget);
      budget = remaining;
      next = following;
    }

    return findAffectedTests({ changed, allTests, readFile: (p) => contents.get(p) });
  }

  /** Run one grep per 200-file batch over the candidate tests (one batched process, not one per file). */
  private async grepNeedles(rest: string[], needles: string[], cwd: string): Promise<Set<string>> {
    if (!needles.length) return new Set();
    const batches: string[][] = [];
    for (let i = 0; i < rest.length; i += 200) batches.push(rest.slice(i, i + 200));
    const greps = await Promise.all(
      batches.map((batch) =>
        this.exec(["grep", "-l", "-F", ...needles.flatMap((n) => ["-e", n]), "--", ...batch], { cwd }),
      ),
    );
    const hits = new Set<string>();
    for (const grep of greps) {
      for (const hit of grep.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) hits.add(hit);
    }
    return hits;
  }

  /** Read the contents of a set of test files into a Map (undefined reads are skipped). */
  private async readContents(files: string[], cwd: string, contents: Map<string, string>): Promise<void> {
    const texts = await Promise.all(files.map((p) => readText(this.exec, path.join(cwd, p))));
    files.forEach((p, i) => {
      const text = texts[i];
      if (text !== undefined) contents.set(p, text);
    });
  }

  /**
   * Breadth-first reads of `frontier` (skip files already in `contents`),
   * costing one budget unit each. Returns the next frontier (imports of the
   * freshly read files) and the remaining budget.
   */
  private async readFrontier(
    frontier: string[],
    cwd: string,
    contents: Map<string, string>,
    budget: number,
  ): Promise<{ next: string[]; budget: number }> {
    const pending = frontier.filter((p) => !contents.has(p)).slice(0, budget);
    const texts = await Promise.all(pending.map((p) => readText(this.exec, path.join(cwd, p))));
    const next: string[] = [];
    pending.forEach((p, i) => {
      const text = texts[i];
      if (text === undefined) return;
      contents.set(p, text);
      for (const spec of relativeImports(text)) {
        next.push(...spellings(resolveSpecifier(p, spec)));
      }
    });
    return { next, budget: budget - pending.length };
  }

  /** Identifier at the diagnostic's location, read from the (still live) scratch. */
  private async locationSymbol(scratch: Scratch | null, diagnostic: string): Promise<string | null> {
    const loc = diagnosticLocation(diagnostic);
    if (!scratch || !loc || loc.file.startsWith("/") || loc.file.split("/").includes("..")) return null;
    const source = await readText(this.exec, path.join(scratch.dir, this.opts.projectDir, loc.file));
    return source === undefined ? null : identifierAt(source, loc.line, loc.column);
  }

  /** Real-tree contents of the patch's files and their direct relative imports, for retry definitions. */
  private async definitionSources(files: PatchFile[]): Promise<{ path: string; content: string }[]> {
    const out: { path: string; content: string }[] = [];
    const seen = new Set<string>();
    const queue = files.slice(0, 8).map((f) => f.path);
    // Bound the total work: a diagnostic rarely needs more than a handful.
    return this.drainDefinitions(queue, seen, 16, out);
  }

  /** Process one definition candidate at a time (recursive so no await sits in a loop). */
  private async drainDefinitions(
    queue: string[],
    seen: Set<string>,
    budget: number,
    out: { path: string; content: string }[],
  ): Promise<{ path: string; content: string }[]> {
    if (queue.length === 0 || budget <= 0) return out;
    const file = queue.shift()!;
    if (!seen.has(file)) {
      seen.add(file);
      if (!unsafePatchPaths([{ path: file, status: "M" }]).length) {
        const content = await readText(this.exec, path.join(this.opts.repoRoot, file));
        if (content !== undefined) {
          out.push({ path: file, content });
          budget -= 1;
          for (const spec of relativeImports(content)) {
            const stem = resolveSpecifier(file, spec);
            if (stem.startsWith("..") || stem.includes("/../")) continue;
            for (const candidate of [`${stem}.ts`, `${stem}/index.ts`, `${stem}.tsx`]) {
              if (!seen.has(candidate) && budget > 0) queue.push(candidate);
            }
          }
        }
      }
    }
    return this.drainDefinitions(queue, seen, budget, out);
  }

  /** Apply to the real tree (check first, so a moved tree is a conflict, never a partial apply). */
  private async land(candidate: { id: string; diff: string }): Promise<void> {
    const root = this.opts.repoRoot;
    const patchFile = path.join(path.dirname(root), `.oracle-land-${candidate.id.replace(/[^\w.-]/g, "_")}.patch`);
    await writeFileViaExec(this.exec, patchFile, candidate.diff);
    try {
      const check = await this.exec(["git", "-C", root, "apply", "--check", "--whitespace=nowarn", patchFile]);
      if (check.exitCode !== 0) throw new Error(`real tree rejected the patch: ${check.stderr.trim()}`);
      const apply = await this.exec(["git", "-C", root, "apply", "--whitespace=nowarn", patchFile]);
      if (apply.exitCode !== 0) throw new Error(`git apply failed: ${apply.stderr.trim()}`);
      if (this.opts.commitMessage) {
        const paths = parsePatchFiles(candidate.diff).flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path]));
        const add = await this.exec(["git", "-C", root, "add", "-A", "--", ...paths]);
        if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`);
        const commit = await this.exec(["git", "-C", root, "commit", "--quiet", "-m", this.opts.commitMessage, "--", ...paths]);
        if (commit.exitCode !== 0) throw new Error(`git commit failed: ${commit.stderr.trim()}`);
      }
    } finally {
      await this.exec(["rm", "-f", patchFile]);
    }
  }
}

/** Convenience wrapper: `new OracleGate(exec, options).run(candidates)`. */
export function runOracleGate(
  exec: OracleExec,
  candidates: OracleCandidate[],
  options: OracleGateOptions,
): Promise<OracleReport> {
  return new OracleGate(exec, options).run(candidates);
}
