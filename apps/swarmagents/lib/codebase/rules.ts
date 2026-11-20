/**
 * The rules that define "what this codebase looks like".
 *
 * They live here (instead of inside the analyzer program) for two reasons:
 *
 *   - the scanner that runs inside the user's VM is generated from these
 *     values, so the VM and the server always agree on what counts as a
 *     source file, how imports are spelled and which exports are public;
 *   - they are plain data, so the unit tests can assert on them directly.
 */

import path from "node:path";

/** Directories that never contain source worth mapping. */
export const IGNORE_DIRS: readonly string[] = [
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  ".swarm",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
  "target",
];

/** Lock files and generated bundles: big, noisy, never worth mapping. */
export const IGNORE_FILES: readonly string[] = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "composer.lock",
  "Cargo.lock",
  "poetry.lock",
  "go.sum",
  ".DS_Store",
];

/** Extensions the scanner parses for imports/exports. */
export const SOURCE_EXTS: readonly string[] = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".rb",
  ".php",
];

/** Extension -> language label used in the pack's language histogram. */
export const EXT_LANG: Readonly<Record<string, string>> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  rb: "Ruby",
  php: "PHP",
  css: "CSS",
  scss: "CSS",
  html: "HTML",
  json: "JSON",
  md: "Markdown",
  yaml: "YAML",
  yml: "YAML",
  sh: "Shell",
  sql: "SQL",
};

/** `import x from "y"` / `export * from "y"` — the static import forms. */
export const STATIC_IMPORT_RE = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
/** `require("y")` — CommonJS. */
export const REQUIRE_RE = /require\(\s*["']([^"']+)["']\s*\)/g;
/** `import("y")` — dynamic import. */
export const DYNAMIC_IMPORT_RE = /import\(\s*["']([^"']+)["']\s*\)/g;
/** `from .x import y` / `import x` — Python. */
export const PYTHON_IMPORT_RE = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm;

/**
 * The export forms the scanner understands, in the order they are reported.
 * `kind: "list"` means the capture holds a comma separated export list
 * (`export { a, b as c }`); `kind: "name"` means it holds a single name.
 */
export const EXPORT_PATTERNS: ReadonlyArray<{ re: RegExp; kind: "name" | "list" }> = [
  { re: /export\s+(?:async\s+)?function\*?\s+([A-Za-z0-9_$]+)/g, kind: "name" },
  { re: /export\s+class\s+([A-Za-z0-9_$]+)/g, kind: "name" },
  { re: /export\s+(?:const|let|var|type|interface|enum)\s+([A-Za-z0-9_$]+)/g, kind: "name" },
  { re: /export\s*\{\s*([^}]+)\s*\}/g, kind: "list" },
  { re: /export\s+default\s+(?:function\*?\s+|class\s+)?([A-Za-z0-9_$]+)/g, kind: "name" },
];

/** Python: top-level defs/classes. */
export const PYTHON_EXPORT_RE = /^(?:def|class)\s+([A-Za-z0-9_]+)/gm;
/** Go: exported top-level identifiers. */
export const GO_EXPORT_RE = /^(?:func|type|const|var)\s+([A-Z][A-Za-z0-9_]*)/gm;
/** Rust: public items. */
export const RUST_EXPORT_RE = /^\s*pub\s+(?:fn|struct|enum|trait|type|const)\s+([A-Za-z0-9_]+)/gm;

/** Weights of the heat formula: churn x size x fan-in x agent touches. */
export const HEAT_WEIGHTS = {
  churn: 0.4,
  size: 0.2,
  fanIn: 0.25,
  touches: 0.15,
} as const;

/** Hard ceiling for the injected context pack, in tokens. */
export const CONTEXT_PACK_TOKEN_BUDGET = 8000;

/** Files larger than this are measured but not parsed. */
export const MAX_PARSED_FILE_BYTES = 120_000;

/** Files smaller than this are parsed even when they are not source files. */
export const MAX_SMALL_FILE_BYTES = 16_000;

/** Cap on the number of files the scanner reports. */
export const MAX_SCANNED_FILES = 20_000;

/** Cap on the number of import specifiers kept per file. */
export const MAX_IMPORTS_PER_FILE = 200;

/** The language of a file, derived from its extension. */
export function languageForPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (EXT_LANG[ext]) return EXT_LANG[ext];
  const base = path.basename(filePath).toLowerCase();
  if (base === "dockerfile") return "Dockerfile";
  if (base === "makefile") return "Makefile";
  return undefined;
}
