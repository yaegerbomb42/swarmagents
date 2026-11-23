import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectFramework } from "./detect";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("detectFramework: vitest from dependency and config", (t) => {
  const dir = mkTmp("tw-vitest-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ devDependencies: { vitest: "^1.0.0" }, scripts: { test: "vitest run" } }));
  fs.writeFileSync(path.join(dir, "vitest.config.ts"), "export default {}\n");
  const d = detectFramework(path.join(dir, "src", "foo.ts"));
  assert.equal(d.framework, "vitest");
  assert.ok(d.confidence >= 0.9);
  assert.ok(d.coverageCommand.join(" ").includes("vitest"));
});

test("detectFramework: jest from dependency", (t) => {
  const dir = mkTmp("tw-jest-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ devDependencies: { jest: "^29.0.0" }, scripts: { test: "jest" } }));
  const d = detectFramework(dir);
  assert.equal(d.framework, "jest");
  assert.ok(d.confidence >= 0.9);
  assert.ok(d.coverageCommand.some((x) => x.includes("jest") || x === "jest"));
});

test("detectFramework: node:test from package script using --test", (t) => {
  const dir = mkTmp("tw-node-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  const d = detectFramework(dir);
  assert.equal(d.framework, "node:test");
  assert.ok(d.confidence >= 0.8);
  assert.ok(d.coverageCommand[0] === "npx" && d.coverageCommand.includes("c8"));
});

test("detectFramework: pytest from pyproject/conftest", (t) => {
  const dir = mkTmp("tw-py-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\nminversion = '6.0'\n");
  fs.writeFileSync(path.join(dir, "conftest.py"), "import pytest\n");
  const d = detectFramework(dir);
  assert.equal(d.framework, "pytest");
  assert.ok(d.confidence >= 0.9);
  assert.ok(d.coverageCommand.join(" ").includes("pytest"));
});

test("detectFramework: go test from go.mod", (t) => {
  const dir = mkTmp("tw-go-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/x\n\ngo 1.22\n");
  const d = detectFramework(path.join(dir, "pkg"));
  assert.equal(d.framework, "go test");
  assert.ok(d.confidence >= 0.9);
  assert.deepEqual(d.testCommand.slice(0, 2), ["go", "test"]);
  assert.ok(d.coverageCommand.includes("-coverprofile=coverage.out"));
});

test("detectFramework: unknown when no signals", (t) => {
  const dir = mkTmp("tw-none-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const d = detectFramework(dir);
  assert.equal(d.framework, "unknown");
  assert.equal(d.confidence, 0);
});

test("detectFramework: a JS/TS repo under a parent with requirements.txt is not pytest", (t) => {
  const root = mkTmp("tw-parent-req-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // A bare requirements.txt (no pytest, no conftest, no python target) sits one
  // directory above a TypeScript repo and must not shadow the JS detection.
  fs.writeFileSync(path.join(root, "requirements.txt"), "requests==2.31.0\n");
  const repo = path.join(root, "app");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(repo, "sum.test.ts"), "import { test } from 'node:test';\n");
  const d = detectFramework(path.join(repo, "sum.test.ts"));
  assert.notEqual(d.framework, "pytest", "bare requirements.txt must not shadow a JS/TS repo");
  assert.equal(d.framework, "node:test");
});

test("detectFramework: a Vite app without Vitest is not vitest", (t) => {
  const dir = mkTmp("tw-vite-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A Vite config that references neither vitest nor a test block is not a
  // Vitest signal, even though vite.config.ts was previously treated as one.
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }));
  fs.writeFileSync(path.join(dir, "vite.config.ts"), "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n");
  const d = detectFramework(path.join(dir, "src", "App.tsx"));
  assert.notEqual(d.framework, "vitest", "a Vite app without Vitest must not be detected as vitest");
});

test("detectFramework: broken symlink as the target does not crash", () => {
  const dir = mkTmp("tw-broken-link-");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ devDependencies: { vitest: "^1.0.0" } }));
  const link = path.join(dir, "dangling.ts");
  fs.symlinkSync(path.join(dir, "does-not-exist.ts"), link);
  // Must not throw: statSync on a dangling link raises ENOENT.
  const d = detectFramework(link);
  assert.equal(d.framework, "vitest");
  assert.ok(d.confidence >= 0.9);
});

test("detectFramework: broken symlink under the scanned tree does not crash", () => {
  const dir = mkTmp("tw-broken-tree-");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ devDependencies: { vitest: "^1.0.0" } }));
  fs.symlinkSync(path.join(dir, "missing.ts"), path.join(dir, "dangling.ts"));
  const real = path.join(dir, "real.ts");
  fs.writeFileSync(real, "export const x = 1;\n");
  const d = detectFramework(real);
  assert.equal(d.framework, "vitest");
  assert.ok(d.confidence >= 0.9);
});
