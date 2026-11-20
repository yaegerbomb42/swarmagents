import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface FixtureRepo {
  root: string;
  cleanup: () => void;
}

function mk(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

export function createVitestFixture(): FixtureRepo {
  const root = mk("tw-vitest-fixture-");
  write(path.join(root, "package.json"), JSON.stringify({
    name: "tw-vitest-fixture",
    private: true,
    type: "module",
    scripts: { test: "vitest run", "test:coverage": "vitest run --coverage" },
    devDependencies: { vitest: "^2.0.0", "@vitest/coverage-v8": "^2.0.0" },
  }, null, 2));
  write(path.join(root, "vitest.config.ts"), `import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node" } });
`);
  write(path.join(root, "src", "sum.ts"), `export function sum(a: number, b: number): number {
  return a + b;
}
`);
  // intentionally minimal/no tests initially for test-gen scenarios
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export function createPytestFixture(): FixtureRepo {
  const root = mk("tw-pytest-fixture-");
  write(path.join(root, "pyproject.toml"), `[project]
name = "tw-pytest-fixture"
version = "0.0.1"

[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-q"
`);
  write(path.join(root, "mypkg", "__init__.py"), "");
  write(path.join(root, "mypkg", "mathlib.py"), `def add(a, b):
    return a + b


def is_even(n):
    return n % 2 == 0
`);
  write(path.join(root, "tests", "test_placeholder.py"), `def test_placeholder():
    assert True
`);
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export function maybeRun(cmd: string, args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
    return { ok: true, stdout, stderr: "", status: 0 };
  } catch (err: any) {
    return {
      ok: false,
      stdout: String(err?.stdout ?? ""),
      stderr: String(err?.stderr ?? err?.message ?? err),
      status: typeof err?.status === "number" ? err.status : 1,
    };
  }
}
