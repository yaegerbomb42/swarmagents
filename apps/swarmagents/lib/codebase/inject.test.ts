import test from "node:test";
import assert from "node:assert/strict";
import { resolveCodebaseInjection, wrapCodebasePack } from "./inject";
import { writeUserSettings, readUserSettings } from "../providers/settings";
import { forgetCodebaseMap } from "./store";
import type { CodebaseMap, CodebaseRepoOption, CodebaseScan, CodebaseScanner } from "./types";

const SCAN: CodebaseScan = {
  repoRoot: "/workspace/demo",
  repoName: "demo",
  repoHash: "hash",
  generatedAt: new Date(0).toISOString(),
  gitHead: "head-1",
  files: [
    { path: "src/core.ts", bytes: 100, language: "TypeScript", exports: ["core"] },
    { path: "src/app.ts", bytes: 50, language: "TypeScript", imports: ["./core"] },
  ],
  churn: { "src/core.ts": 10 },
};

function scanner(selected: string | null = SCAN.repoRoot): CodebaseScanner {
  return {
    async scan(): Promise<CodebaseScan | null> {
      return SCAN;
    },
    async head(): Promise<string | undefined> {
      return "head-1";
    },
    async publish(_userId: string, _repoRoot: string, _map: CodebaseMap): Promise<void> {},
    async listRepos(): Promise<CodebaseRepoOption[]> {
      return [];
    },
    async readMap(): Promise<CodebaseMap | null> {
      return null;
    },
    async selectedRepo(): Promise<string | null> {
      return selected;
    },
    async selectRepo(): Promise<void> {},
  };
}

test("the pack is injected when the setting is on (the default)", async () => {
  const userId = "inject-default";
  const result = await resolveCodebaseInjection(userId, scanner(), SCAN.repoRoot);
  assert.equal(result.enabled, true);
  assert.equal(result.injected, true);
  assert.ok(result.text?.includes("src/core.ts"));
  assert.ok((result.tokenEstimate ?? 0) > 0);
  forgetCodebaseMap(userId, SCAN.repoRoot);
});

test("the pack is not injected when the user turned it off", async () => {
  const userId = "inject-off";
  writeUserSettings(userId, { preferFreeProviders: true, injectCodebaseContext: false });
  assert.equal(readUserSettings(userId).injectCodebaseContext, false);
  const result = await resolveCodebaseInjection(userId, scanner(), SCAN.repoRoot);
  assert.equal(result.enabled, false);
  assert.equal(result.injected, false);
  assert.equal(result.reason, "disabled");
  forgetCodebaseMap(userId, SCAN.repoRoot);
});

test("the pack is not injected when the account never picked a repository", async () => {
  const userId = "inject-no-repo";
  const result = await resolveCodebaseInjection(userId, scanner(null), SCAN.repoRoot);
  assert.equal(result.enabled, true);
  assert.equal(result.injected, false);
  assert.equal(result.reason, "no-repo-picked");
  forgetCodebaseMap(userId, SCAN.repoRoot);
});

test("the pack is wrapped in markers that identify it in the prompt", () => {
  const wrapped = wrapCodebasePack("# Codebase context: demo", { repoHash: "abc" });
  assert.match(wrapped, /^<codebase_context repo_hash="abc">/);
  assert.match(wrapped, /<\/codebase_context>$/);
  assert.match(wrapped, /# Codebase context: demo/);
});
