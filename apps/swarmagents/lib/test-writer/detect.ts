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

function safeRead(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

interface Marker {
  path: string;
  /** Directory levels between `startDir` and the marker's directory (0 = same dir). */
  distance: number;
}

function findUpInfo(startDir: string, names: string[], limit = 8): Marker | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < limit; i++) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return { path: candidate, distance: i };
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

/** Markers close to the target weigh more than ones many directories above it. */
function proximityWeight(marker: Marker | null): number {
  if (!marker) return 0;
  // Gentle decay: distance 0 → 1.0, distance 1 → 0.95, … floor at 0.5.
  return Math.max(0.5, 1 - 0.05 * marker.distance);
}

interface Candidate {
  framework: TestFramework;
  score: number;
  reasons: string[];
  testCommand: string[];
  coverageCommand: string[];
}

/** Scores below this resolve to "unknown". */
const MIN_CONFIDENCE = 0.4;

function scoreFramework(targetPath: string): FrameworkDetection {
  const abs = path.resolve(targetPath);
  const dir = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
  const ext = path.extname(abs).toLowerCase();

  const pkgM = findUpInfo(dir, ["package.json"]);
  const pkg = pkgM ? readJson<Pkg>(pkgM.path) : null;
  const scripts = pkg?.scripts ?? {};
  const scriptText = Object.values(scripts).join(" \n ");

  const pyM = findUpInfo(dir, ["pyproject.toml", "pytest.ini", "tox.ini", "setup.cfg", "requirements.txt"]);
  const conftestM = findUpInfo(dir, ["conftest.py"]);
  const goM = findUpInfo(dir, ["go.mod"]);
  const vitestConfigM = findUpInfo(dir, ["vitest.config.ts", "vitest.config.js", "vitest.config.mts", "vitest.config.mjs"]);
  const viteM = findUpInfo(dir, ["vite.config.ts", "vite.config.js"]);
  const jestConfigM = findUpInfo(dir, ["jest.config.ts", "jest.config.js", "jest.config.mjs", "jest.config.cjs", "jest.config.json"]);

  const candidates: Candidate[] = [];

  // ---- pytest ----
  {
    let score = 0;
    const reasons: string[] = [];
    if (pyM) {
      const name = path.basename(pyM.path);
      const w = proximityWeight(pyM);
      if (name === "pyproject.toml") {
        if (/\[tool\.pytest|pytest/i.test(safeRead(pyM.path))) {
          score = Math.max(score, 0.95 * w);
          reasons.push("pyproject pytest config");
        } else {
          score = Math.max(score, 0.6 * w);
          reasons.push("pyproject.toml");
        }
      } else if (name === "pytest.ini" || name === "tox.ini") {
        score = Math.max(score, 0.95 * w);
        reasons.push(name);
      } else if (name === "setup.cfg") {
        if (/\[tool:pytest|pytest/i.test(safeRead(pyM.path))) {
          score = Math.max(score, 0.9 * w);
          reasons.push("setup.cfg pytest config");
        } else {
          score = Math.max(score, 0.4 * w);
          reasons.push(name);
        }
      } else {
        // requirements.txt: only a real pytest signal, never the default.
        if (/pytest/i.test(safeRead(pyM.path))) {
          score = Math.max(score, 0.8 * w);
          reasons.push("requirements.txt lists pytest");
        } else {
          score = Math.max(score, 0.25 * w);
          reasons.push("requirements.txt (weak)");
        }
      }
    }
    if (conftestM) {
      score = Math.max(score, 0.75 * proximityWeight(conftestM));
      reasons.push("conftest.py");
    }
    if (ext === ".py") {
      score = Math.max(score, 0.85);
      reasons.push("python target");
    }
    candidates.push({
      framework: "pytest",
      score,
      reasons,
      testCommand: ["python3", "-m", "pytest", "-q"],
      coverageCommand: ["python3", "-m", "pytest", "--cov", "--cov-report=term-missing", "-q"],
    });
  }

  // ---- go ----
  {
    let score = 0;
    const reasons: string[] = [];
    if (goM) {
      score = Math.max(score, 0.95 * proximityWeight(goM));
      reasons.push("go.mod");
    }
    if (ext === ".go") {
      score = Math.max(score, 0.85);
      reasons.push("go target");
    }
    candidates.push({
      framework: "go test",
      score,
      reasons,
      testCommand: ["go", "test", "./..."],
      coverageCommand: ["go", "test", "./...", "-coverprofile=coverage.out", "-covermode=atomic"],
    });
  }

  // ---- vitest ----
  {
    let score = 0;
    const reasons: string[] = [];
    const vitestDep = hasDep(pkg, "vitest");
    if (vitestDep) {
      score = Math.max(score, 0.95 * proximityWeight(pkgM));
      reasons.push("vitest dependency");
    }
    if (vitestConfigM) {
      score = Math.max(score, 0.92 * proximityWeight(vitestConfigM));
      reasons.push(path.basename(vitestConfigM.path));
    }
    if (/\bvitest\b/i.test(scriptText)) {
      score = Math.max(score, 0.85);
      reasons.push("vitest script");
    }
    // A bare vite.config is not a Vitest signal unless it actually configures it.
    if (viteM && !vitestDep && !vitestConfigM) {
      if (/vitest|test\s*:/i.test(safeRead(viteM.path))) {
        score = Math.max(score, 0.8 * proximityWeight(viteM));
        reasons.push("vite.config references vitest");
      }
    }
    candidates.push({
      framework: "vitest",
      score,
      reasons,
      testCommand: ["npx", "vitest", "run"],
      coverageCommand: ["npx", "vitest", "run", "--coverage"],
    });
  }

  // ---- jest ----
  {
    let score = 0;
    const reasons: string[] = [];
    const jestDep = hasDep(pkg, "jest") || hasDep(pkg, "@jest/globals") || hasDep(pkg, "ts-jest");
    if (jestDep) {
      score = Math.max(score, 0.95 * proximityWeight(pkgM));
      reasons.push("jest dependency");
    }
    if (jestConfigM) {
      score = Math.max(score, 0.88 * proximityWeight(jestConfigM));
      reasons.push(path.basename(jestConfigM.path));
    }
    if (/\bjest\b/i.test(scriptText)) {
      score = Math.max(score, 0.85);
      reasons.push("jest script");
    }
    candidates.push({
      framework: "jest",
      score,
      reasons,
      testCommand: ["npx", "jest", "--runInBand"],
      coverageCommand: ["npx", "jest", "--coverage", "--runInBand"],
    });
  }

  // ---- node:test ----
  {
    let score = 0;
    const reasons: string[] = [];
    const usesNodeTest = Boolean(pkg && (scripts.test?.includes("--test") || scripts["test:unit"]?.includes("--test")));
    if (usesNodeTest) {
      score = Math.max(score, 0.9 * proximityWeight(pkgM));
      reasons.push("package script uses node --test");
    }
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(abs) && pkgM) {
      score = Math.max(score, 0.45 * proximityWeight(pkgM));
      reasons.push("js/ts target with package.json");
    }
    candidates.push({
      framework: "node:test",
      score,
      reasons,
      testCommand: scripts["test:unit"] ? ["npm", "run", "test:unit"] : ["npm", "test"],
      coverageCommand: ["npx", "c8", "--reporter=text", "--reporter=json-summary", "npm", "test"],
    });
  }

  let best = candidates[0];
  for (const candidate of candidates) {
    if (candidate.score > best.score) best = candidate;
  }
  if (best.score >= MIN_CONFIDENCE) {
    return {
      framework: best.framework,
      confidence: Math.min(1, best.score),
      reasons: best.reasons,
      testCommand: best.testCommand,
      coverageCommand: best.coverageCommand,
    };
  }

  const reasons = candidates.flatMap((candidate) => candidate.reasons);
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
