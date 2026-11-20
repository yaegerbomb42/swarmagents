import test from "node:test";
import assert from "node:assert/strict";
import { buildMapFromScan } from "./analyze";
import {
  buildDependencySlice,
  composeStrikePrompt,
  isStrikeAction,
  resolveSliceTarget,
} from "./slice";
import type { CodebaseMap, CodebaseScan } from "./types";

function map(): CodebaseMap {
  const scan: CodebaseScan = {
    repoRoot: "/workspace/demo",
    repoName: "demo",
    repoHash: "abcdef0123456789",
    generatedAt: new Date(0).toISOString(),
    files: [
      { path: "src/core.ts", bytes: 100, language: "TypeScript", exports: ["core"] },
      { path: "src/a.ts", bytes: 50, language: "TypeScript", imports: ["./core"] },
      { path: "src/b.ts", bytes: 50, language: "TypeScript", imports: ["./core", "./a"] },
      { path: "src/c.ts", bytes: 50, language: "TypeScript" },
      { path: "lib/util.ts", bytes: 50, language: "TypeScript", imports: ["../src/core"] },
    ],
    churn: {},
  };
  return buildMapFromScan(scan, { repoRoot: "/workspace/demo" });
}

test("resolveSliceTarget resolves a file and a top-level module", () => {
  const m = map();
  assert.deepEqual(resolveSliceTarget(m, "src/a.ts"), {
    path: "src/a.ts",
    kind: "file",
    files: ["src/a.ts"],
  });
  const mod = resolveSliceTarget(m, "src");
  assert.equal(mod?.kind, "module");
  assert.deepEqual(mod?.files, ["src/a.ts", "src/b.ts", "src/c.ts", "src/core.ts"]);
  const lib = resolveSliceTarget(m, "lib");
  assert.equal(lib?.kind, "module");
  assert.deepEqual(lib?.files, ["lib/util.ts"]);
  assert.equal(resolveSliceTarget(m, "src/nope.ts"), null);
  assert.equal(resolveSliceTarget(m, "nope"), null);
});

test("resolveSliceTarget refuses paths that escape the repo", () => {
  const m = map();
  assert.equal(resolveSliceTarget(m, "../outside.ts"), null);
  assert.equal(resolveSliceTarget(m, "/etc/passwd"), null);
  assert.equal(resolveSliceTarget(m, "src/../../etc/passwd"), null);
  assert.equal(resolveSliceTarget(m, ""), null);
  assert.equal(resolveSliceTarget(m, "./src/a.ts")?.path, "src/a.ts");
});

test("buildDependencySlice takes the target, its imports and its importers", () => {
  const m = map();
  const slice = buildDependencySlice(m, "src/a.ts");
  assert.equal(slice.kind, "file");
  assert.equal(slice.files[0], "src/a.ts");
  // Direct import (core) and direct importer (b) are in; the rest is not.
  assert.ok(slice.files.includes("src/core.ts"));
  assert.ok(slice.files.includes("src/b.ts"));
  assert.ok(!slice.files.includes("src/c.ts"));
  assert.ok(!slice.files.includes("lib/util.ts"));
  assert.match(slice.text, /Dependency slice: src\/a\.ts \(file\)/);
  assert.match(slice.text, /src\/core\.ts/);
  assert.ok(slice.tokenEstimate > 0);
});

test("buildDependencySlice for a module pulls in outside importers of its files", () => {
  const m = map();
  const slice = buildDependencySlice(m, "src");
  assert.equal(slice.kind, "module");
  for (const file of ["src/a.ts", "src/b.ts", "src/c.ts", "src/core.ts"]) {
    assert.ok(slice.files.includes(file), `missing ${file}`);
  }
  // lib/util.ts imports src/core.ts, so it fans into the module.
  assert.ok(slice.files.includes("lib/util.ts"));
});

test("buildDependencySlice respects the token budget and keeps the target first", () => {
  const m = map();
  const slice = buildDependencySlice(m, "src/a.ts", 70);
  assert.equal(slice.files[0], "src/a.ts");
  assert.ok(slice.tokenEstimate <= 70);
  // The full slice has three files; the tight budget cuts the rest.
  assert.ok(slice.files.length < 3);
  assert.ok(slice.text.includes("src/a.ts"));
});

test("buildDependencySlice throws for a path outside the map", () => {
  const m = map();
  assert.throws(() => buildDependencySlice(m, "nope.ts"), /not a file or top-level module/);
});

test("composeStrikePrompt scopes each action to the slice", () => {
  const m = map();
  const slice = buildDependencySlice(m, "src/a.ts");
  const refactor = composeStrikePrompt("refactor", slice, { complexity: 12 });
  assert.match(refactor, /Refactor this hotspot/);
  assert.match(refactor, /complexity is 12/);
  assert.match(refactor, /Work only inside the listed slice/);
  assert.match(refactor, /src\/a\.ts/);

  const tests = composeStrikePrompt("tests", slice, { coveragePct: 25 });
  assert.match(tests, /Write the missing tests/);
  assert.match(tests, /25\.0%/);
  assert.match(tests, /Work only inside the listed slice/);

  const untested = composeStrikePrompt("tests", slice, { coveragePct: null });
  assert.match(untested, /No coverage data was found/);

  const explain = composeStrikePrompt("explain", slice);
  assert.match(explain, /Explain this module's architecture/);
  assert.match(explain, /architecture lens/);
});

test("composeStrikePrompt embeds server-side lens findings instead of asking the agent to run the lens", () => {
  const m = map();
  const slice = buildDependencySlice(m, "src/a.ts");
  const diagram = "```mermaid\nflowchart TD\nA[src/a.ts] --> B[src/b.ts]\n```";
  const explain = composeStrikePrompt("explain", slice, { lensFindings: diagram });
  assert.match(explain, /Explain this module's architecture/);
  assert.match(explain, /Architecture lens findings/);
  assert.ok(explain.includes(diagram), "the diagram rides in the prompt");
  assert.match(explain, /verify each edge/);
  assert.doesNotMatch(explain, /Use the architecture lens on the slice/);
  assert.match(explain, /Work only inside the listed slice/);
});

test("isStrikeAction accepts only the three actions", () => {
  assert.equal(isStrikeAction("refactor"), true);
  assert.equal(isStrikeAction("tests"), true);
  assert.equal(isStrikeAction("explain"), true);
  assert.equal(isStrikeAction("delete"), false);
  assert.equal(isStrikeAction(undefined), false);
});
