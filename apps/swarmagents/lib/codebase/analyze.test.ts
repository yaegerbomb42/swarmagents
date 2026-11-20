import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMapFromScan,
  buildTopLevelModules,
  detectConventions,
  detectEntryPoints,
  normalizeCoverageMap,
  primaryPackage,
  resolveImportTarget,
  selectHotspots,
} from "./analyze";
import type { CodebaseScan } from "./types";

function scan(overrides: Partial<CodebaseScan> = {}): CodebaseScan {
  return {
    repoRoot: "/workspace/demo",
    repoName: "demo",
    repoHash: "abcdef0123456789",
    generatedAt: new Date(0).toISOString(),
    gitHead: "deadbeef",
    files: [],
    churn: {},
    ...overrides,
  };
}

test("resolveImportTarget resolves relative imports to scanned files", () => {
  const known = new Set(["src/index.ts", "src/lib/util.ts", "src/lib/index.ts"]);
  assert.equal(resolveImportTarget("src/app.ts", "./lib/util", known), "src/lib/util.ts");
  assert.equal(resolveImportTarget("src/app.ts", "./lib/util.ts", known), "src/lib/util.ts");
  assert.equal(resolveImportTarget("src/app.ts", "./lib", known), "src/lib/index.ts");
  assert.equal(resolveImportTarget("src/app.ts", "react", known), null);
  assert.equal(resolveImportTarget("src/app.ts", "../outside", known), null);
});

test("buildMapFromScan counts import fan-in", () => {
  const map = buildMapFromScan(
    scan({
      files: [
        { path: "src/core.ts", bytes: 100, language: "TypeScript", exports: ["core"] },
        { path: "src/a.ts", bytes: 50, language: "TypeScript", imports: ["./core"] },
        { path: "src/b.ts", bytes: 50, language: "TypeScript", imports: ["./core"] },
        { path: "src/c.ts", bytes: 50, language: "TypeScript", imports: ["./a"] },
      ],
    }),
    { repoRoot: "/workspace/demo" },
  );
  assert.equal(map.files.find((f) => f.path === "src/core.ts")?.fanIn, 2);
  assert.equal(map.files.find((f) => f.path === "src/a.ts")?.fanIn, 1);
  assert.equal(map.files.find((f) => f.path === "src/b.ts")?.fanIn, 0);
  assert.equal(map.contextPack.keyFiles[0].path, "src/core.ts");
  assert.equal(map.contextPack.keyFiles[0].fanIn, 2);
});

test("buildMapFromScan reports the languages of the repository", () => {
  const map = buildMapFromScan(
    scan({
      files: [
        { path: "a.ts", bytes: 10, language: "TypeScript" },
        { path: "b.ts", bytes: 10, language: "TypeScript" },
        { path: "c.py", bytes: 10, language: "Python" },
      ],
    }),
    { repoRoot: "/workspace/demo" },
  );
  assert.deepEqual(map.languages, { TypeScript: 2, Python: 1 });
  assert.match(map.contextPack.text, /languages: TypeScript:2, Python:1/);
});

test("buildMapFromScan folds the churn into the heatmap", () => {
  const map = buildMapFromScan(
    scan({
      files: [
        { path: "hot.ts", bytes: 500, language: "TypeScript" },
        { path: "cold.ts", bytes: 100, language: "TypeScript" },
      ],
      churn: { "hot.ts": 900 },
    }),
    { repoRoot: "/workspace/demo" },
  );
  assert.equal(map.heatmap[0].path, "hot.ts");
  assert.ok(map.heatmap[0].heat > map.heatmap[1].heat);
  assert.equal(selectHotspots(map, 1).length, 1);
});

test("buildMapFromScan weights the files the agent touched", () => {
  const files = [
    { path: "a.ts", bytes: 1000, language: "TypeScript" },
    { path: "b.ts", bytes: 1000, language: "TypeScript" },
  ];
  const plain = buildMapFromScan(scan({ files }), { repoRoot: "/workspace/demo" });
  const touched = buildMapFromScan(scan({ files }), {
    repoRoot: "/workspace/demo",
    agentTouchesByPath: { "b.ts": 4 },
  });
  assert.equal(touched.heatmap[0].path, "b.ts");
  assert.ok(touched.heatmap[0].heat > plain.heatmap[0].heat);
});

test("buildMapFromScan reports the build and test commands", () => {
  const map = buildMapFromScan(
    scan({
      files: [{ path: "package.json", bytes: 100, language: "JSON" }],
      packageJson: {
        scripts: { build: "next build", test: "npm test", typecheck: "tsc --noEmit" },
        devDependencies: { vitest: "^1.0.0", eslint: "^9.0.0" },
        packageManager: "pnpm@9.0.0",
      },
    }),
    { repoRoot: "/workspace/demo" },
  );
  assert.deepEqual(map.buildCommands, ["npm run build", "npm run typecheck"]);
  assert.deepEqual(map.testCommands, ["npm run test"]);
  assert.equal(map.conventions.testFramework, "vitest");
  assert.equal(map.conventions.lint, "eslint");
  assert.equal(map.conventions.packageManager, "pnpm");
  assert.match(map.contextPack.text, /tests: npm run test/);
});

test("primaryPackage falls back to the shallowest package of a monorepo", () => {
  const monorepo = scan({
    packageFiles: [
      { path: "apps/web/package.json", scripts: { build: "vite build" } },
      { path: "apps/api/package.json", scripts: { build: "tsc", test: "node --test" } },
    ],
  });
  // Same depth: the package that actually describes how to work wins.
  assert.equal(primaryPackage(monorepo)?.scripts?.build, "tsc");

  const withRoot = scan({
    packageJson: { scripts: { build: "turbo build" } },
    packageFiles: [{ path: "apps/web/package.json", scripts: { build: "vite build" } }],
  });
  assert.equal(primaryPackage(withRoot)?.scripts?.build, "turbo build");
});

test("detectConventions reads the lock files for the package manager", () => {
  const conventions = detectConventions({ scripts: { test: "node --test" } }, ["pnpm-lock.yaml"]);
  assert.equal(conventions.packageManager, "pnpm");
  assert.equal(conventions.testFramework, "node:test");
});

test("detectConventions finds the runner behind a test:* wrapper script", () => {
  const conventions = detectConventions({
    scripts: {
      test: "npm run test:unit",
      "test:unit": "SWARM_HOME=$(mktemp -d) tsx --test \"lib/**/*.test.ts\"",
    },
  });
  assert.equal(conventions.testFramework, "node:test");
});

test("detectEntryPoints finds the pages and the API routes", () => {
  const points = detectEntryPoints([
    "app/page.tsx",
    "app/api/runs/route.ts",
    "src/main.ts",
    "lib/thing.ts",
  ]);
  assert.ok(points.includes("app/page.tsx"));
  assert.ok(points.includes("app/api/runs/route.ts"));
  assert.ok(points.includes("src/main.ts"));
});

test("normalizeCoverageMap relativizes absolute, relative and foreign keys", () => {
  const known = new Set(["src/a.ts", "src/b.ts"]);
  const normalized = normalizeCoverageMap(
    {
      "/other/checkout/src/a.ts": 99,
      "/workspace/demo/src/a.ts": 80,
      "src/b.ts": 42.5,
      "src/missing.ts": 10,
      "/etc/passwd": 100,
    },
    "/workspace/demo",
    known,
  );
  // The foreign absolute key for a.ts loses to the exact repo-root key.
  assert.equal(normalized.get("src/a.ts"), 80);
  assert.equal(normalized.get("src/b.ts"), 42.5);
  assert.equal(normalized.size, 2);
});

test("normalizeCoverageMap clamps percentages to 0..100", () => {
  const known = new Set(["a.ts", "b.ts"]);
  const normalized = normalizeCoverageMap({ "a.ts": 140, "b.ts": -5 }, "/workspace/demo", known);
  assert.equal(normalized.get("a.ts"), 100);
  assert.equal(normalized.get("b.ts"), 0);
});

test("buildMapFromScan threads complexity and coverage into files and heatmap", () => {
  const map = buildMapFromScan(
    scan({
      files: [
        { path: "src/hot.ts", bytes: 500, language: "TypeScript", complexity: 12 },
        { path: "src/cold.ts", bytes: 100, language: "TypeScript" },
      ],
      coverage: { "/workspace/demo/src/hot.ts": 37.5 },
    }),
    { repoRoot: "/workspace/demo" },
  );
  const hot = map.files.find((f) => f.path === "src/hot.ts");
  const cold = map.files.find((f) => f.path === "src/cold.ts");
  assert.equal(hot?.complexity, 12);
  assert.equal(hot?.coveragePct, 37.5);
  // Unknown complexity is omitted, not zero; missing coverage is null.
  assert.equal(cold?.complexity, undefined);
  assert.equal(cold?.coveragePct, null);
  const hotEntry = map.heatmap.find((entry) => entry.path === "src/hot.ts");
  assert.equal(hotEntry?.complexity, 12);
  assert.equal(hotEntry?.coveragePct, 37.5);
  const coldEntry = map.heatmap.find((entry) => entry.path === "src/cold.ts");
  assert.equal(coldEntry?.coveragePct, null);
});

test("buildMapFromScan records resolved direct imports on each file", () => {
  const map = buildMapFromScan(
    scan({
      files: [
        { path: "src/core.ts", bytes: 100, language: "TypeScript" },
        { path: "src/a.ts", bytes: 50, language: "TypeScript", imports: ["./core", "react"] },
      ],
    }),
    { repoRoot: "/workspace/demo" },
  );
  assert.deepEqual(map.files.find((f) => f.path === "src/a.ts")?.imports, ["src/core.ts"]);
  assert.equal(map.files.find((f) => f.path === "src/core.ts")?.imports, undefined);
});

test("buildTopLevelModules describes each top-level module", () => {
  const infos = new Map([
    ["lib/a.ts", { path: "lib/a.ts", bytes: 10, fanIn: 0, churn90d: 0, agentTouches: 0, heat: 0 }],
    ["README.md", { path: "README.md", bytes: 10, fanIn: 0, churn90d: 0, agentTouches: 0, heat: 0 }],
  ]);
  const modules = buildTopLevelModules(["lib/a.ts", "README.md"], infos);
  const lib = modules.find((m) => m.path === "lib");
  const readme = modules.find((m) => m.path === "README.md");
  assert.equal(lib?.kind, "dir");
  assert.equal(lib?.purpose, "Shared server/client libraries");
  assert.equal(readme?.kind, "file");
  assert.equal(readme?.purpose, "Project readme / overview");
});
