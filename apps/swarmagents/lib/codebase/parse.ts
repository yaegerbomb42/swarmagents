/**
 * Purpose heuristics: one short line per file and per top-level module.
 *
 * The pack is only useful if a line tells the agent *what a thing is*, so
 * these heuristics look at where a file lives and what it is called before
 * they fall back to the file's first meaningful line.
 */

const FILE_PURPOSE_RULES: ReadonlyArray<{ test: (p: string, base: string) => boolean; purpose: string }> = [
  { test: (_p, base) => base.startsWith("readme"), purpose: "Project readme / overview" },
  { test: (_p, base) => base === "package.json", purpose: "Package manifest and scripts" },
  { test: (_p, base) => base.startsWith("tsconfig"), purpose: "TypeScript configuration" },
  { test: (_p, base) => base.startsWith("next.config"), purpose: "Next.js configuration" },
  { test: (_p, base) => base === "dockerfile" || base.startsWith("docker-compose"), purpose: "Container / build definition" },
  { test: (_p, base) => base.startsWith("makefile"), purpose: "Makefile" },
  { test: (p) => p.includes("/test/") || p.includes("/tests/") || p.includes("/spec/"), purpose: "Tests" },
  { test: (p) => p.includes("__tests__"), purpose: "Tests" },
  { test: (p) => /\.(test|spec)\.[a-z]+$/.test(p), purpose: "Tests" },
  { test: (p) => p.includes("/components/"), purpose: "UI component" },
  { test: (p) => p.includes("/app/api/") && p.endsWith("route.ts"), purpose: "API route handler" },
  { test: (p) => p.includes("/app/") && p.endsWith("page.tsx"), purpose: "App page" },
  { test: (p) => p.includes("/lib/runtime/"), purpose: "Runtime / execution logic" },
  { test: (p) => p.includes("/lib/harness/"), purpose: "Agent harness" },
  { test: (p) => p.includes("/lib/vm/"), purpose: "VM management" },
  { test: (p) => p.includes("/lib/providers/"), purpose: "LLM / provider integration" },
  { test: (p) => p.includes("/lib/client/"), purpose: "Client helpers" },
  { test: (p) => p.includes("/e2e/"), purpose: "End-to-end tests" },
  { test: (p) => p.includes("/lib/"), purpose: "Library module" },
  { test: (p) => p.includes("/scripts/"), purpose: "Build / maintenance script" },
  { test: (p) => p.includes("/docs/"), purpose: "Documentation" },
];

/** A one-line description of what a file is for. */
export function inferPurpose(filePath: string, content?: string): string | undefined {
  const base = filePath.split("/").pop()?.toLowerCase() ?? "";
  const p = filePath.replace(/\\/g, "/").toLowerCase();
  for (const rule of FILE_PURPOSE_RULES) {
    if (rule.test(p, base)) return rule.purpose;
  }
  if (content) {
    const first = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(
        (line) =>
          line &&
          !line.startsWith("//") &&
          !line.startsWith("/*") &&
          !line.startsWith("*") &&
          !line.startsWith("#!") &&
          !line.startsWith("import ") &&
          !line.startsWith("export ") &&
          !line.startsWith('"use'),
      )
      ?.replace(/^#+\s*/, "");
    if (first && first.length >= 12 && first.length <= 120) return first;
  }
  return undefined;
}

const MODULE_PURPOSE_RULES: ReadonlyArray<{ test: (p: string, files: string[]) => boolean; purpose: string }> = [
  { test: (p) => p === "app" || p.endsWith("/app"), purpose: "Next.js app routes and pages" },
  { test: (p) => p === "apps" || p.endsWith("/apps"), purpose: "Application packages" },
  { test: (p) => p === "packages" || p.endsWith("/packages"), purpose: "Shared packages" },
  { test: (p) => p === "lib" || p.endsWith("/lib"), purpose: "Shared server/client libraries" },
  { test: (p) => p === "components" || p.endsWith("/components"), purpose: "Shared UI components" },
  { test: (p) => p.includes("runtime"), purpose: "Runtime control plane and run execution" },
  { test: (p) => p.includes("harness"), purpose: "Agent harness and tool execution" },
  { test: (p) => p.includes("vm"), purpose: "VM drivers, lifecycle and file access" },
  { test: (p) => p.includes("provider"), purpose: "LLM provider config and routing" },
  { test: (p) => p.includes("client"), purpose: "Browser/client utilities" },
  { test: (p) => p.includes("telemetry"), purpose: "Run telemetry and reporting" },
  { test: (p) => p.includes("e2e"), purpose: "End-to-end test specs" },
  { test: (p) => p.split("/").includes("api"), purpose: "API routes" },
  { test: (p) => p.includes("minimalist-ui"), purpose: "Minimalist UI workspace app" },
  { test: (p) => p.includes("infra"), purpose: "Infrastructure and deployment" },
  { test: (p) => p.includes("scripts"), purpose: "Build and maintenance scripts" },
  { test: (p) => p.includes("docs"), purpose: "Documentation" },
  { test: (p) => p.includes("test") || p.includes("spec"), purpose: "Tests" },
];

/** A one-line description of what a top-level module holds. */
export function guessModulePurpose(modulePath: string, files: string[]): string {
  const p = modulePath.toLowerCase();
  for (const rule of MODULE_PURPOSE_RULES) {
    if (rule.test(p, files)) return rule.purpose;
  }
  // A directory that is mostly tests is a test directory.
  const testFiles = files.filter((file) => /\.(test|spec)\./.test(file)).length;
  if (files.length > 0 && testFiles / files.length >= 0.6) return "Tests";
  return "Module";
}
