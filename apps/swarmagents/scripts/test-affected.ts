#!/usr/bin/env npx tsx
/**
 * test-affected — run only the tests affected by a set of changed files.
 *
 * "Affected" means: the test file itself changed, a sibling test of a
 * changed source module (`a/b.ts` → `a/b.test.ts` / `a/b.*.test.ts`), or a
 * test that imports a changed module via a relative specifier. This is the
 * same impact analysis the oracle gate uses, exposed here so agents (and
 * humans) can run a fast, targeted check on their own working tree without
 * paying for the whole suite.
 *
 * Usage (run from apps/swarmagents):
 *   npx tsx scripts/test-affected.ts                    # changed files vs HEAD
 *   npx tsx scripts/test-affected.ts lib/a.ts lib/b.ts  # explicit changed files
 *   npx tsx scripts/test-affected.ts --rev origin/main  # changed vs a base branch
 *
 * Exit codes: 0 all affected tests pass (or none affected), 1 failures,
 * 2 usage error.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findAffectedTests } from "../lib/harness/oracle/affected.js";

const PROJECT_ROOT = path.resolve(__dirname, "..");

/** Test glob roots, mirroring package.json's test:unit globs. */
const TEST_ROOTS = ["lib", "app", "components", "minimalist-ui/src", "packages/swarm-node/src"];

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

/** Recursively collect project-relative test files under the root. */
function collectTests(root: string): string[] {
  const out: string[] = [];
  const fullRoot = path.join(PROJECT_ROOT, root);
  if (!fs.existsSync(fullRoot)) return out;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules and build output inside roots, if any.
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(full);
      } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
        out.push(path.relative(PROJECT_ROOT, full));
      }
    }
  };
  walk(fullRoot);
  return out.sort();
}

function readFile(p: string): string | undefined {
  try {
    return fs.readFileSync(path.join(PROJECT_ROOT, p), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Rebase a path to project-relative, or undefined when it lives outside the
 * project. Accepts both repo-root-relative (`apps/swarmagents/lib/foo.ts`)
 * and already project-relative (`lib/foo.ts`) inputs.
 */
function toProjectPath(repoPath: string): string | undefined {
  const rel = repoPath.replace(/^\.\//, "").split("/");
  if (rel.length >= 2 && rel[0] === "apps" && rel[1] === "swarmagents") return rel.slice(2).join("/");
  if (rel.length >= 1 && rel[0] === "swarmagents") return rel.slice(1).join("/");
  // Already project-relative (e.g. "lib/foo.ts", "app/api/logout/route.ts").
  if (rel[0] === "lib" || rel[0] === "app" || rel[0] === "components" || rel[0] === "minimalist-ui" || rel[0] === "packages") {
    return rel.join("/");
  }
  return undefined; // outside the project
}

/** Parse the change list from args, or default to `git diff` vs a base. */
function resolveChanges(args: string[]): { path: string; status: "A" | "M" | "D" }[] {
  let files = args;
  let base = "HEAD";
  if (args[0] === "--rev") {
    base = args[1];
    files = args.slice(2);
  }

  const rebase = (raw: { path: string; status: "A" | "M" | "D" }[]) =>
    raw
      .map<{ path: string; status: "A" | "M" | "D" } | null>((c) => {
        const p = toProjectPath(c.path);
        return p === undefined ? null : { path: p, status: c.status };
      })
      .filter((c): c is { path: string; status: "A" | "M" | "D" } => c !== null);

  if (files.length > 0) {
    return rebase(files.map((f) => ({ path: f, status: "M" as const })));
  }

  // Default: changed files versus base.
  const res = spawnSync("git", ["diff", "--name-status", "--diff-filter=AMDR", base], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
  if (res.status !== 0 || res.stdout.trim() === "") {
    // Fall back to working-tree status.
    const st = spawnSync("git", ["status", "--porcelain"], { cwd: PROJECT_ROOT, encoding: "utf8" });
    if (st.status !== 0) {
      console.error("test-affected: cannot determine changed files (not a git repo?)");
      process.exit(2);
    }
    const raw = st.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const status = line.slice(0, 2).trim();
        const p = line.slice(3).trim().replace(/^"|"$/g, "");
        const kind = status === "D" ? ("D" as const) : status === "A" ? ("A" as const) : ("M" as const);
        return { path: p, status: kind };
      });
    return rebase(raw);
  }

  const raw = res.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, p] = line.split(/\s+/, 2);
      const kind = status === "D" ? ("D" as const) : status === "A" ? ("A" as const) : ("M" as const);
      return { path: p, status: kind };
    });
  return rebase(raw);
}

function main(): void {
  const changes = resolveChanges(process.argv.slice(2));
  if (changes.length === 0) {
    console.log("test-affected: no changed files; nothing to run.");
    process.exit(0);
  }

  const allTests = TEST_ROOTS.flatMap((root) => collectTests(root));
  const uniqueTests = [...new Set(allTests)].sort();

  const affected = findAffectedTests({ changed: changes, allTests: uniqueTests, readFile });

  if (affected.length === 0) {
    console.log(`test-affected: ${changes.length} changed file(s), no affected tests; nothing to run.`);
    process.exit(0);
  }

  console.log(`test-affected: ${changes.length} changed file(s) → ${affected.length} affected test(s):`);
  for (const t of affected) console.log(`  ${t}`);

  const swarmHome = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "swarm-home-"));
  const res = spawnSync(
    "npx",
    ["tsx", "--test", "--test-concurrency=4", ...affected],
    { cwd: PROJECT_ROOT, env: { ...process.env, SWARM_HOME: swarmHome }, stdio: "inherit" },
  );

  fs.rmSync(swarmHome, { recursive: true, force: true });
  if (res.status !== 0) {
    // Ensure non-zero even if child didn't exit with a status.
    process.exit(res.status ?? 1);
  }
}

main();
