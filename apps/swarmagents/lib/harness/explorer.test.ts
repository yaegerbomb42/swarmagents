/**
 * Tests for the disposable read-only explorer subagent
 * (lib/harness/explorer.ts): the five-tool read-only registry, the
 * Ground-Truth Brief schema, the disk verification pass, the step /
 * wall-clock caps, and the parallel fan-out — including an integration
 * test that dispatches three queries against this repository with a
 * scripted model endpoint.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  EXPLORER_MAX_BRIEF_TOKENS,
  EXPLORER_MAX_QUERIES,
  EXPLORER_TOOL_NAMES,
  dispatchExplorer,
  estimateBriefTokens,
  executeExplorerTool,
  normalizeBrief,
  runExplorer,
  verifyBriefLocations,
  type GroundTruthBrief,
  type ModelEndpointConfig,
} from "./explorer";

const ENDPOINT: ModelEndpointConfig = { baseUrl: "http://localhost:9/explorer-test", model: "explorer-test" };

function makeRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "explorer-test-"));
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(
    join(root, "lib/math.ts"),
    "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport const PI = 3.14;\n",
  );
  writeFileSync(
    join(root, "lib/util.ts"),
    "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n",
  );
  writeFileSync(join(root, "README.md"), "# Test repo\n");
  // A symlink inside the repo pointing outside it: the sandbox must never follow it.
  const outside = join(tmpdir(), `explorer-outside-${process.pid}.txt`);
  writeFileSync(outside, "SECRET_OUTSIDE_MARKER\n");
  symlinkSync(outside, join(root, "lib/escape-link.ts"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeGitRepo(): { root: string; cleanup: () => void } {
  const { root, cleanup } = makeRepo();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "explorer-test@example.invalid");
  git("config", "user.name", "explorer-test");
  git("add", ".");
  git("commit", "-q", "-m", "add math helper");
  git("commit", "-q", "--allow-empty", "-m", "tune greeting");
  return { root, cleanup };
}

/** A fetch stub returning canned model steps in order (repeating the last). Respects the abort signal. */
function cannedFetch(
  steps: unknown[],
  delayMs = 0,
): { fetchImpl: typeof fetch; calls: () => number } {
  let i = 0;
  let calls = 0;
  const fetchImpl = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
    calls++;
    if (delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    }
    const step = steps[Math.min(i++, steps.length - 1)];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(step) } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

function finalBrief(overrides: Partial<GroundTruthBrief> = {}): GroundTruthBrief {
  return {
    query: "Where is add defined?",
    directAnswer: "In lib/math.ts.",
    relevantLocations: [
      { path: "lib/math.ts", symbol: "add", lineStart: 1, lineEnd: 1, role: "definition", snippet: "export function add(a: number, b: number): number {" },
    ],
    invariantsAndGotchas: [],
    confidence: "high",
    ...overrides,
  };
}

test("the registry holds exactly the five read-only tools; mutating tools are rejected", () => {
  assert.deepEqual([...EXPLORER_TOOL_NAMES], ["ripgrep", "glob", "ast_outline", "read_file_range", "git_log_grep"]);
  const { root, cleanup } = makeRepo();
  try {
    for (const forbidden of ["bash", "write_file", "edit_file", "str_replace", "Task", "rm"]) {
      const res = executeExplorerTool(root, forbidden, {});
      assert.equal(res.ok, false, `${forbidden} must be rejected`);
      assert.match(res.summary, /forbidden/);
    }
    // Unknown names are rejected the same way.
    assert.equal(executeExplorerTool(root, "nope", {}).ok, false);
  } finally {
    cleanup();
  }
});

test("ripgrep finds matches with file:line, respects maxMatches, and rejects bad regex", () => {
  const { root, cleanup } = makeRepo();
  try {
    const res = executeExplorerTool(root, "ripgrep", { pattern: "greet" });
    assert.equal(res.ok, true);
    const data = res.data as { matches: Array<{ path: string; line: number; text: string }> };
    assert.deepEqual(
      data.matches.map((m) => [m.path, m.line]),
      [["lib/util.ts", 1]],
    );
    const capped = executeExplorerTool(root, "ripgrep", { pattern: "export", maxMatches: 1 });
    assert.equal((capped.data as { matches: unknown[] }).matches.length, 1);
    assert.equal(executeExplorerTool(root, "ripgrep", { pattern: "(" }).ok, false);
    assert.equal(executeExplorerTool(root, "ripgrep", {}).ok, false);
    // Scoped to one file.
    const scoped = executeExplorerTool(root, "ripgrep", { pattern: "greet", path: "lib/math.ts" });
    assert.deepEqual((scoped.data as { matches: unknown[] }).matches, []);
  } finally {
    cleanup();
  }
});

test("ripgrep never follows a symlink out of the repo and rejects escaping paths", () => {
  const { root, cleanup } = makeRepo();
  try {
    const res = executeExplorerTool(root, "ripgrep", { pattern: "SECRET_OUTSIDE_MARKER" });
    assert.deepEqual((res.data as { matches: unknown[] }).matches, []);
    assert.equal(executeExplorerTool(root, "ripgrep", { pattern: "x", path: "../outside" }).ok, false);
    assert.equal(executeExplorerTool(root, "ripgrep", { pattern: "x", path: "/etc/passwd" }).ok, false);
  } finally {
    cleanup();
  }
});

test("glob matches **, *, and ? over repo-relative paths", () => {
  const { root, cleanup } = makeRepo();
  try {
    const all = executeExplorerTool(root, "glob", { pattern: "**/*.ts" });
    const files = (all.data as { files: string[] }).files;
    assert.ok(files.includes("lib/math.ts"));
    assert.ok(files.includes("lib/util.ts"));
    assert.ok(!files.includes("lib/escape-link.ts"), "symlinks are not listed");
    const libOnly = executeExplorerTool(root, "glob", { pattern: "lib/*.ts" });
    assert.deepEqual((libOnly.data as { files: string[] }).files, ["lib/math.ts", "lib/util.ts"]);
    const none = executeExplorerTool(root, "glob", { pattern: "nomatch*" });
    assert.deepEqual((none.data as { files: string[] }).files, []);
    assert.equal(executeExplorerTool(root, "glob", {}).ok, false);
  } finally {
    cleanup();
  }
});

test("ast_outline lists top-level declarations with line numbers", () => {
  const { root, cleanup } = makeRepo();
  try {
    const res = executeExplorerTool(root, "ast_outline", { path: "lib/math.ts" });
    assert.equal(res.ok, true);
    const data = res.data as { declarations: Array<{ name: string; kind: string; line: number }>; totalLines: number };
    assert.deepEqual(data.declarations, [
      { name: "add", kind: "function", line: 1 },
      { name: "PI", kind: "const", line: 5 },
    ]);
    assert.equal(data.totalLines, 5);
    assert.equal(executeExplorerTool(root, "ast_outline", { path: "missing.ts" }).ok, false);
    assert.equal(executeExplorerTool(root, "ast_outline", { path: "../outside" }).ok, false);
  } finally {
    cleanup();
  }
});

test("read_file_range returns exact lines and rejects out-of-range and escaping paths", () => {
  const { root, cleanup } = makeRepo();
  try {
    const res = executeExplorerTool(root, "read_file_range", { path: "lib/math.ts", startLine: 1, endLine: 2 });
    assert.equal(res.ok, true);
    const data = res.data as { lines: string[]; startLine: number; endLine: number; totalLines: number };
    assert.deepEqual(data.lines, ["export function add(a: number, b: number): number {", "  return a + b;"]);
    assert.equal(data.totalLines, 5);
    assert.equal(executeExplorerTool(root, "read_file_range", { path: "lib/math.ts", startLine: 99 }).ok, false);
    assert.equal(executeExplorerTool(root, "read_file_range", { path: "lib/math.ts", startLine: 3, endLine: 2 }).ok, false);
    assert.equal(executeExplorerTool(root, "read_file_range", { path: "lib/escape-link.ts", startLine: 1 }).ok, false);
    assert.equal(executeExplorerTool(root, "read_file_range", { path: "/etc/passwd", startLine: 1 }).ok, false);
  } finally {
    cleanup();
  }
});

test("git_log_grep searches commit messages and fails closed outside a repo", () => {
  const { root, cleanup } = makeGitRepo();
  try {
    const res = executeExplorerTool(root, "git_log_grep", { pattern: "math" });
    assert.equal(res.ok, true);
    const commits = (res.data as { commits: Array<{ hash: string; subject: string }> }).commits;
    assert.equal(commits.length, 1);
    assert.equal(commits[0].subject, "add math helper");
    const none = executeExplorerTool(root, "git_log_grep", { pattern: "zzz-no-such-commit" });
    assert.deepEqual((none.data as { commits: unknown[] }).commits, []);
    assert.equal(executeExplorerTool(root, "git_log_grep", {}).ok, false);
  } finally {
    cleanup();
  }
  const plain = makeRepo();
  try {
    assert.equal(executeExplorerTool(plain.root, "git_log_grep", { pattern: "x" }).ok, false);
  } finally {
    plain.cleanup();
  }
});

test("normalizeBrief repairs over-long answers and snippets; the schema rejects bad shapes", () => {
  const long = finalBrief({
    directAnswer: Array.from({ length: 200 }, (_, i) => `word${i}`).join(" "),
    relevantLocations: [
      {
        path: "lib/math.ts",
        lineStart: 1,
        lineEnd: 1,
        role: "definition",
        snippet: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"),
      },
    ],
  });
  const repaired = normalizeBrief(long);
  assert.ok(repaired);
  assert.equal(repaired?.directAnswer.split(/\s+/).length, 120);
  assert.equal(repaired?.relevantLocations[0].snippet.split("\n").length, 12);
  assert.equal(normalizeBrief({ ...finalBrief(), relevantLocations: [{ path: "x", lineStart: 1, lineEnd: 1, role: "bogus", snippet: "y" }] }), null);
  assert.equal(normalizeBrief({ ...finalBrief(), directAnswer: "" }), null);
  assert.equal(normalizeBrief(null), null);
  assert.equal(normalizeBrief("nope"), null);
});

test("verifyBriefLocations strips hallucinations, corrects snippets, clamps ranges, and downgrades confidence", () => {
  const { root, cleanup } = makeRepo();
  try {
    const brief = finalBrief({
      confidence: "high",
      relevantLocations: [
        { path: "lib/math.ts", symbol: "add", lineStart: 1, lineEnd: 1, role: "definition", snippet: "WRONG SNIPPET" },
        { path: "lib/ghost.ts", lineStart: 1, lineEnd: 1, role: "caller", snippet: "nope" },
        { path: "lib/util.ts", lineStart: 1, lineEnd: 99, role: "definition", snippet: "export function greet(name: string): string {" },
        { path: "lib/math.ts", lineStart: 99, lineEnd: 100, role: "caller", snippet: "nope" },
        { path: "../escape.ts", lineStart: 1, lineEnd: 1, role: "caller", snippet: "nope" },
        { path: "lib/escape-link.ts", lineStart: 1, lineEnd: 1, role: "caller", snippet: "SECRET_OUTSIDE_MARKER" },
      ],
    });
    const { brief: verified, stripped, corrected } = verifyBriefLocations(root, brief);
    assert.equal(stripped, 4, "ghost, out-of-range, escaping, and symlink locations are stripped");
    assert.equal(corrected, 2, "wrong snippet corrected, over-long range clamped with its snippet fixed");
    assert.equal(verified.relevantLocations.length, 2);
    assert.equal(verified.relevantLocations[0].snippet, "export function add(a: number, b: number): number {");
    assert.equal(verified.relevantLocations[1].lineEnd, 3, "lineEnd clamps to the file's last line");
    assert.equal(verified.relevantLocations[1].snippet, "export function greet(name: string): string {\n  return `hi ${name}`;\n}");
    assert.equal(verified.confidence, "medium", "one notch down from high");
    assert.match(verified.missingInfo ?? "", /hallucinated/);
    assert.match(verified.missingInfo ?? "", /ghost/);

    const clean = verifyBriefLocations(root, finalBrief());
    assert.equal(clean.stripped, 0);
    assert.equal(clean.corrected, 0);
    assert.equal(clean.brief.confidence, "high", "a fully verified brief keeps its confidence");
  } finally {
    cleanup();
  }
});

test("runExplorer stops at maxSteps and returns a low-confidence brief", async () => {
  const { root, cleanup } = makeRepo();
  try {
    const { fetchImpl, calls } = cannedFetch([
      { action: "tool", tool: "ripgrep", args: { pattern: "add" } },
    ]);
    const brief = await runExplorer("Where is add defined?", {
      repoRoot: root,
      endpoint: ENDPOINT,
      maxSteps: 3,
      fetchImpl,
    });
    assert.equal(calls(), 3, "exactly maxSteps model calls");
    assert.equal(brief.confidence, "low");
    assert.match(brief.missingInfo ?? "", /budget exhausted after 3 steps/);
    assert.deepEqual(brief.relevantLocations, []);
  } finally {
    cleanup();
  }
});

test("runExplorer honors the wall-clock cap when the model never answers in time", async () => {
  const { root, cleanup } = makeRepo();
  try {
    const { fetchImpl } = cannedFetch([{ action: "tool", tool: "ripgrep", args: { pattern: "add" } }], 500);
    const started = performance.now();
    const brief = await runExplorer("Where is add defined?", {
      repoRoot: root,
      endpoint: ENDPOINT,
      maxWallClockMs: 100,
      fetchImpl,
    });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1000, `must abort near the cap, took ${elapsed}ms`);
    assert.equal(brief.confidence, "low");
    assert.match(brief.missingInfo ?? "", /Model call failed/);
  } finally {
    cleanup();
  }
});

test("runExplorer asks the model to fix an invalid brief, then uses the repaired one", async () => {
  const { root, cleanup } = makeRepo();
  try {
    const { fetchImpl } = cannedFetch([
      { action: "final", brief: { ...finalBrief(), relevantLocations: [{ path: "x", lineStart: 1, lineEnd: 1, role: "bogus", snippet: "y" }] } },
      { action: "final", brief: finalBrief() },
    ]);
    const brief = await runExplorer("Where is add defined?", { repoRoot: root, endpoint: ENDPOINT, fetchImpl });
    assert.equal(brief.confidence, "high");
    assert.equal(brief.relevantLocations.length, 1);
    assert.equal(brief.relevantLocations[0].path, "lib/math.ts");
  } finally {
    cleanup();
  }
});

test("dispatchExplorer validates its input", async () => {
  const { root, cleanup } = makeRepo();
  try {
    await assert.rejects(dispatchExplorer({ queries: [], repoRoot: root, endpoint: ENDPOINT }), /non-empty array/);
    await assert.rejects(
      dispatchExplorer({ queries: ["a", "b", "c", "d", "e"], repoRoot: root, endpoint: ENDPOINT }),
      new RegExp(`at most ${EXPLORER_MAX_QUERIES}`),
    );
    await assert.rejects(dispatchExplorer({ queries: ["  "], repoRoot: root, endpoint: ENDPOINT }), /non-empty string/);
    await assert.rejects(
      dispatchExplorer({ queries: ["q"], repoRoot: join(root, "no-such-dir"), endpoint: ENDPOINT }),
      /not a directory/,
    );
  } finally {
    cleanup();
  }
});

/**
 * Scripted model for the integration test: stateless, so the three parallel
 * explorers can share it. First call: ripgrep for the longest identifier in
 * the query. Later calls: a final brief citing the first ripgrep match.
 */
function integrationFetch(delayMs: number): typeof fetch {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as {
      messages?: Array<{ role: string; content: string }>;
    };
    const messages = body.messages ?? [];
    const query = messages.find((m) => m.role === "user")?.content ?? "";
    const toolResult = [...messages].reverse().find((m) => m.role === "user" && m.content.startsWith("Tool ripgrep result:"));
    let step: unknown;
    if (!toolResult) {
      const words = query.match(/[A-Za-z_$][\w$]*/g) ?? [];
      const pattern = words.sort((a, b) => b.length - a.length)[0] ?? query;
      step = { action: "tool", tool: "ripgrep", args: { pattern } };
    } else {
      const result = JSON.parse(toolResult.content.slice("Tool ripgrep result: ".length)) as {
        data?: { matches?: Array<{ path: string; line: number; text: string }> };
      };
      const match = result.data?.matches?.[0];
      step = {
        action: "final",
        brief: match
          ? {
              query,
              directAnswer: `Found in ${match.path} at line ${match.line}.`,
              relevantLocations: [
                { path: match.path, lineStart: match.line, lineEnd: match.line, role: "definition", snippet: match.text },
              ],
              invariantsAndGotchas: [],
              confidence: "high",
            }
          : {
              query,
              directAnswer: "No matching code was found.",
              relevantLocations: [],
              invariantsAndGotchas: [],
              confidence: "low",
              missingInfo: "ripgrep returned no matches.",
            },
      };
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(step) } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

test("integration: dispatch_explorer answers 3 queries against this repo in parallel", { timeout: 60_000 }, async () => {
  const repoRoot = process.cwd();
  const queries = [
    "Where is readAuditPage defined?",
    "What does execWithTimeout do on timeout?",
    "How does verifyBriefLocations work?",
  ];
  const fetchImpl = integrationFetch(150);

  // Baseline: one explorer on its own.
  const t0 = performance.now();
  const single = await runExplorer(queries[0], { repoRoot, endpoint: ENDPOINT, fetchImpl });
  const singleMs = performance.now() - t0;
  assert.ok(single.relevantLocations.length >= 1, "single explorer finds a real location");

  // Three explorers at once: wall-clock bounded by the slowest single
  // explorer, not the sum of the three.
  const t1 = performance.now();
  const briefs = await dispatchExplorer({ queries, repoRoot, endpoint: ENDPOINT, fetchImpl });
  const parallelMs = performance.now() - t1;
  assert.equal(briefs.length, 3);
  for (const [i, brief] of briefs.entries()) {
    assert.equal(brief.query, queries[i]);
    assert.ok(brief.relevantLocations.length >= 1, `brief ${i} cites a real location`);
    assert.equal(brief.confidence, "high");
  }
  assert.ok(parallelMs < singleMs * 2.5, `parallel ${parallelMs.toFixed(0)}ms vs single ${singleMs.toFixed(0)}ms`);
  assert.ok(parallelMs < 10_000, `parallel run must stay well under the 20s cap, took ${parallelMs.toFixed(0)}ms`);

  // Every cited location exists on disk with a verbatim snippet.
  for (const brief of briefs) {
    for (const loc of brief.relevantLocations) {
      assert.ok(!loc.path.startsWith("/") && !loc.path.includes(".."), "paths stay inside the repo");
      const file = join(repoRoot, loc.path);
      assert.ok(existsSync(file), `${loc.path} exists`);
      const lines = readFileSync(file, "utf8").split("\n");
      assert.ok(loc.lineStart >= 1 && loc.lineEnd <= lines.length, `${loc.path}:${loc.lineStart}-${loc.lineEnd} in range`);
      assert.equal(loc.snippet, lines.slice(loc.lineStart - 1, loc.lineEnd).join("\n"), "snippet is verbatim");
    }
  }

  // Merged payload under the 1,500-token budget.
  const tokens = estimateBriefTokens(briefs);
  assert.ok(tokens < EXPLORER_MAX_BRIEF_TOKENS, `merged briefs are ${tokens} tokens`);
});

test("roles offer dispatch_explorer to the main, orchestrator, and researcher roles", async () => {
  const { BUILTIN_ROLES, ROLE_TOOLS } = await import("../roles");
  const entry = ROLE_TOOLS.find((t) => t.name === "dispatch_explorer");
  assert.ok(entry, "dispatch_explorer is a known role tool");
  assert.equal(entry?.mutating, false, "the explorer is read-only");
  for (const id of ["main", "orchestrator", "researcher"]) {
    const role = BUILTIN_ROLES.find((r) => r.id === id);
    assert.ok(role?.tools.includes("dispatch_explorer"), `${id} offers dispatch_explorer`);
  }
});
