import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectFramework } from "./detect";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("detectFramework: vitest from dependency and config", () => {
  const dir = mkTmp("tw-vitest-");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ devDependencies: { vitest: "^1.0.0" }, scripts: { test: "vitest run" } }));
  fs.writeFileSync(path.join(dir, "vitest.config.ts"), "export default {}\n");
  const d = detectFramework(path.join(dir, "src", "foo.ts"));
  assert.equal(d.framework, "vitest");
  assert.ok(d.confidence >= 0.9);
  assert.ok(d.coverageCommand.join(" ").includes("vitest"));
});

test("detectFramework: jest from dependency", () => {
  const dir = mkTmp("tw-jest-");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ devDependencies: { jest: "^29.0.0" }, scripts: { test: "jest" } }));
  const d = detectFramework(dir);
  assert.equal(d.framework, "jest");
  assert.ok(d.confidence >= 0.9);
  assert.ok(d.coverageCommand.some((x) => x.includes("jest") || x === "jest"));
});

test("detectFramework: node:test from package script using --test", () => {
  const dir = mkTmp("tw-node-");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  const d = detectFramework(dir);
  assert.equal(d.framework, "node:test");
  assert.ok(d.confidence >= 0.8);
  assert.ok(d.coverageCommand[0] === "npx" && d.coverageCommand.includes("c8"));
});

test("detectFramework: pytest from pyproject/conftest", () => {
  const dir = mkTmp("tw-py-");
  fs.writeFileSync(path.join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\nminversion = '6.0'\n");
  fs.writeFileSync(path.join(dir, "conftest.py"), "import pytest\n");
  const d = detectFramework(dir);
  assert.equal(d.framework, "pytest");
  assert.ok(d.confidence >= 0.9);
  assert.ok(d.coverageCommand.join(" ").includes("pytest"));
});

test("detectFramework: go test from go.mod", () => {
  const dir = mkTmp("tw-go-");
  fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/x\n\ngo 1.22\n");
  const d = detectFramework(path.join(dir, "pkg"));
  assert.equal(d.framework, "go test");
  assert.ok(d.confidence >= 0.9);
  assert.deepEqual(d.testCommand.slice(0, 2), ["go", "test"]);
  assert.ok(d.coverageCommand.includes("-coverprofile=coverage.out"));
});

test("detectFramework: unknown when no signals", () => {
  const dir = mkTmp("tw-none-");
  const d = detectFramework(dir);
  assert.equal(d.framework, "unknown");
  assert.equal(d.confidence, 0);
});
