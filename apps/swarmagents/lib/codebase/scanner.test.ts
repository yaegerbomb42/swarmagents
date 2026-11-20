import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codebaseAnalyzerSource } from "./vm-analyzer-source";
import { scanRepoLocal } from "./local-scanner";

/** Write a small repository to a temp dir and return its path. */
function fixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-repo-"));
  fs.mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "junk"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "core.ts"),
    'export function core() { return 1; }\nexport const VERSION = "1";\n',
  );
  fs.writeFileSync(
    path.join(dir, "src", "app.ts"),
    'import { core } from "./lib/core";\nexport const app = () => core();\n',
  );
  fs.writeFileSync(path.join(dir, "src", "lib", "core.ts"), "export const core = () => 1;\n");
  fs.writeFileSync(
    path.join(dir, "src", "branchy.ts"),
    [
      "export function f(x: number) {",
      "  // if for while: a comment must not count",
      '  const label = "if for while switch"; // a string must not count',
      "  if (x > 1) return 1;",
      "  if (x > 2 && x < 3 || x === 4) return 2;",
      "  for (let i = 0; i < 3; i++) { /* empty */ }",
      "  while (x > 0) { x--; }",
      "  switch (x) { case 1: return 1; default: return 0; }",
      '  try { throw new Error("x"); } catch { return -1; }',
      "  const y = x ?? 2;",
      "  const z = y?.toString();",
      "  return x > 0 ? 1 : 0;",
      "}",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "README.md"), "# Demo\n");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "demo", scripts: { build: "tsc", test: "node --test" } }, null, 2),
  );
  fs.writeFileSync(path.join(dir, "node_modules", "junk", "index.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(dir, "package-lock.json"), "{}\n");
  return dir;
}

test("the analyzer program is valid JavaScript", () => {
  const source = codebaseAnalyzerSource();
  assert.match(source, /^#!\/usr\/bin\/env node/);
  // `new Function` cannot parse ESM, so check it as a module body instead.
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    new Function(`return async () => { ${source.replace(/^#!.*\n/, "").replace(/^import .*$/gm, "")} }`);
  });
});

test("the analyzer finds the source files, their imports and their exports", async () => {
  const repo = fixtureRepo();
  const scan = await scanRepoLocal(repo);
  assert.ok(scan, "the analyzer must produce a scan");
  const paths = scan.files.map((file) => file.path);
  assert.ok(paths.includes("src/app.ts"));
  assert.ok(paths.includes("src/lib/core.ts"));
  assert.ok(paths.includes("README.md"));
  // node_modules and the lock file are noise.
  assert.ok(!paths.some((file) => file.includes("node_modules")));
  assert.ok(!paths.includes("package-lock.json"));

  const core = scan.files.find((file) => file.path === "src/core.ts");
  assert.ok(core?.exports?.includes("core"));
  assert.ok(core?.exports?.includes("VERSION"));

  const app = scan.files.find((file) => file.path === "src/app.ts");
  assert.ok(app?.imports?.includes("./lib/core"));

  const pkg = scan.packageJson;
  assert.equal(pkg?.scripts?.build, "tsc");
  assert.ok(scan.lockFiles?.includes("package-lock.json"));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("the analyzer reports the repository root, its name and its hash", async () => {
  const repo = fixtureRepo();
  const scan = await scanRepoLocal(repo);
  assert.equal(scan?.repoRoot, fs.realpathSync(repo));
  assert.ok((scan?.repoHash ?? "").length === 16);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("the analyzer counts branch complexity, ignoring comments and strings", async () => {
  const repo = fixtureRepo();
  const scan = await scanRepoLocal(repo);
  // if x2, &&, ||, for, while, switch, case, catch, ??, ternary = 11.
  // The comment, the string literal and the ?. optional chain count 0.
  const branchy = scan?.files.find((file) => file.path === "src/branchy.ts");
  assert.equal(branchy?.complexity, 11);
  const core = scan?.files.find((file) => file.path === "src/core.ts");
  assert.equal(core?.complexity, 0);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("the analyzer reads a coverage summary artifact when one exists", async () => {
  const repo = fixtureRepo();
  const coreAbs = path.join(fs.realpathSync(repo), "src", "core.ts");
  fs.mkdirSync(path.join(repo, "coverage"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "coverage", "coverage-summary.json"),
    JSON.stringify({
      [coreAbs]: { lines: { pct: 50 } },
      total: { lines: { pct: 50 } },
    }),
  );
  const scan = await scanRepoLocal(repo);
  assert.equal(scan?.coverage?.[coreAbs], 50);
  assert.equal(scan?.coverage?.["total"], undefined);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("the analyzer falls back to coverage-final.json statement hits", async () => {
  const repo = fixtureRepo();
  const coreAbs = path.join(fs.realpathSync(repo), "src", "core.ts");
  fs.mkdirSync(path.join(repo, "coverage"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "coverage", "coverage-final.json"),
    JSON.stringify({ [coreAbs]: { s: { 0: 1, 1: 0, 2: 3 } } }),
  );
  const scan = await scanRepoLocal(repo);
  const pct = scan?.coverage?.[coreAbs];
  assert.ok(typeof pct === "number" && Math.abs(pct - (200 / 3)) < 0.001, `expected ~66.67, got ${pct}`);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("the analyzer reports no coverage when the repo has no artifact", async () => {
  const repo = fixtureRepo();
  const scan = await scanRepoLocal(repo);
  assert.equal(scan?.coverage, undefined);
  fs.rmSync(repo, { recursive: true, force: true });
});
