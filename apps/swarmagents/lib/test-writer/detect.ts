import fs from "node:fs";
import path from "node:path";

export type TestFramework = "vitest" | "jest" | "node:test" | "pytest" | "go test" | "unknown";

export interface FrameworkDetection {
  framework: TestFramework;
  /** Confidence 0..1; 0 means unknown. */
  confidence: number;
  /** How we decided (file/config signals). */
  reasons: string[];
  /** Suggested test command (argv) for this repo/path. */
  testCommand: string[];
  /** Suggested coverage command (argv) for this framework. */
  coverageCommand: string[];
}

type Pkg = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  type?: string;
};

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function exists(file: string): boolean {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

function findUp(startDir: string, names: string[], limit = 8): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < limit; i++) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function hasDep(pkg: Pkg | null, name: string): boolean {
  if (!pkg) return false;
  return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
}

function scoreFramework(targetPath: string): FrameworkDetection {
  const abs = path.resolve(targetPath);
  const dir = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
  const reasons: string[] = [];

  const pkgPath = findUp(dir, ["package.json"]);
  const pkg = pkgPath ? readJson<Pkg>(pkgPath) : null;
  const root = pkgPath ? path.dirname(pkgPath) : dir;

  const pyproject = findUp(dir, ["pyproject.toml", "pytest.ini", "tox.ini", "setup.cfg", "requirements.txt"]);
  const goMod = findUp(dir, ["go.mod"]);
  const vitestConfig = findUp(dir, ["vitest.config.ts", "vitest.config.js", "vitest.config.mts", "vitest.config.mjs", "vite.config.ts", "vite.config.js"]);
  const jestConfig = findUp(dir, ["jest.config.ts", "jest.config.js", "jest.config.mjs", "jest.config.cjs", "jest.config.json"]);

  // Python / pytest
  if (pyproject) {
    let score = 0.7;
    const base = path.basename(pyproject);
    if (base.startsWith("pytest") || base === "tox.ini") { score = 0.95; reasons.push(base); }
    if (base === "pyproject.toml") {
      try {
        const txt = fs.readFileSync(pyproject, "utf8");
        if (/\[tool\.pytest|pytest/i.test(txt)) { score = 0.95; reasons.push("pyproject pytest config"); }
        else reasons.push("pyproject.toml");
      } catch { reasons.push("pyproject.toml"); }
    } else {
      reasons.push(base);
    }
    if (exists(path.join(dir, "conftest.py")) || exists(path.join(root, "conftest.py"))) { score = Math.max(score, 0.9); reasons.push("conftest.py"); }
    if (/\.py$/i.test(abs)) reasons.push("python target");
    if (/requirements\.txt$/i.test(base)) {
      try {
        const txt = fs.readFileSync(pyproject, "utf8");
        if (!/pytest/i.test(txt) && !exists(path.join(root, "conftest.py")) && !/\.py$/i.test(abs)) {
          // weak signal only
        }
      } catch {}
    }
    if (score >= 0.7) {
      return {
        framework: "pytest",
        confidence: Math.min(1, score),
        reasons,
        testCommand: ["python3", "-m", "pytest", "-q"],
        coverageCommand: ["python3", "-m", "pytest", "--cov", "--cov-report=term-missing", "-q"],
      };
    }
  }

  // Go
  if (goMod || /\.go$/i.test(abs)) {
    const r = ["go.mod or .go target"];
    return {
      framework: "go test",
      confidence: goMod ? 0.98 : 0.85,
      reasons: r,
      testCommand: ["go", "test", "./..."],
      coverageCommand: ["go", "test", "./...", "-coverprofile=coverage.out", "-covermode=atomic"],
    };
  }

  // JS/TS via package.json signals
  const vitestDep = hasDep(pkg, "vitest");
  const jestDep = hasDep(pkg, "jest") || hasDep(pkg, "@jest/globals") || hasDep(pkg, "ts-jest");
  const scripts = pkg?.scripts ?? {};
  const scriptText = Object.values(scripts).join(" \n ");

  if (vitestDep || (vitestConfig && !jestDep) || /\bvitest\b/i.test(scriptText)) {
    if (vitestDep) reasons.push("vitest dependency");
    if (vitestConfig) reasons.push(path.basename(vitestConfig));
    if (/\bvitest\b/i.test(scriptText)) reasons.push("vitest script");
    return {
      framework: "vitest",
      confidence: vitestDep ? 0.99 : vitestConfig ? 0.9 : 0.8,
      reasons,
      testCommand: ["npx", "vitest", "run"],
      coverageCommand: ["npx", "vitest", "run", "--coverage"],
    };
  }

  if (jestDep || jestConfig || /\bjest\b/i.test(scriptText)) {
    if (jestDep) reasons.push("jest dependency");
    if (jestConfig) reasons.push(path.basename(jestConfig));
    if (/\bjest\b/i.test(scriptText)) reasons.push("jest script");
    return {
      framework: "jest",
      confidence: jestDep ? 0.99 : jestConfig ? 0.9 : 0.8,
      reasons,
      testCommand: ["npx", "jest", "--runInBand"],
      coverageCommand: ["npx", "jest", "--coverage", "--runInBand"],
    };
  }

  // node:test heuristics
  if (pkg && (scripts.test?.includes("--test") || scripts["test:unit"]?.includes("--test"))) {
    reasons.push("package script uses node --test");
    return {
      framework: "node:test",
      confidence: 0.9,
      reasons,
      testCommand: scripts["test:unit"] ? ["npm", "run", "test:unit"] : ["npm", "test"],
      coverageCommand: ["npx", "c8", "--reporter=text", "--reporter=json-summary", "npm", "test"],
    };
  }

  // fallback by file extension/context
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(abs) && pkgPath) {
    reasons.push("js/ts target with package.json");
    return {
      framework: "node:test",
      confidence: 0.45,
      reasons,
      testCommand: ["npm", "test"],
      coverageCommand: ["npx", "c8", "--reporter=text", "--reporter=json-summary", "npm", "test"],
    };
  }

  return {
    framework: "unknown",
    confidence: 0,
    reasons: reasons.length ? reasons : ["no framework signals found"],
    testCommand: [],
    coverageCommand: [],
  };
}

export function detectFramework(targetPath: string): FrameworkDetection {
  return scoreFramework(targetPath);
}
