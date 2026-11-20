import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureCodebaseMap,
  forgetCodebaseMap,
  getCodebaseContextPack,
  getCodebaseHotspots,
  maybeRefreshCodebaseMapOnGitChange,
  normalizeRepoPath,
  recordAgentTouches,
} from "./store";
import { buildMapFromScan } from "./analyze";
import type { CodebaseMap, CodebaseRepoOption, CodebaseScan, CodebaseScanner } from "./types";

/** A scanner that serves a fixed scan and counts how often it was asked. */
function fakeScanner(scan: CodebaseScan, options: { head?: string } = {}): CodebaseScanner & {
  scans: number;
  published: CodebaseMap[];
} {
  const published: CodebaseMap[] = [];
  const scanner = {
    scans: 0,
    published,
    async scan(): Promise<CodebaseScan | null> {
      scanner.scans += 1;
      return scan;
    },
    async head(): Promise<string | undefined> {
      return options.head;
    },
    async publish(_userId: string, _repoRoot: string, map: CodebaseMap): Promise<void> {
      published.push(map);
    },
    async listRepos(): Promise<CodebaseRepoOption[]> {
      return [];
    },
    async readMap(): Promise<CodebaseMap | null> {
      return null;
    },
    async selectedRepo(): Promise<string | null> {
      return null;
    },
    async selectRepo(): Promise<void> {},
  };
  return scanner;
}

const SAMPLE: CodebaseScan = {
  repoRoot: "/workspace/demo",
  repoName: "demo",
  repoHash: "hash",
  generatedAt: new Date(0).toISOString(),
  gitHead: "head-1",
  files: [
    { path: "src/core.ts", bytes: 100, language: "TypeScript", exports: ["core"] },
    { path: "src/a.ts", bytes: 50, language: "TypeScript", imports: ["./core"] },
  ],
  churn: { "src/core.ts": 10 },
};

test("ensureCodebaseMap builds the map once and reuses it", async () => {
  const scanner = fakeScanner(SAMPLE, { head: "head-1" });
  const first = await ensureCodebaseMap("alice", scanner, { repoRoot: SAMPLE.repoRoot });
  const second = await ensureCodebaseMap("alice", scanner, { repoRoot: SAMPLE.repoRoot });
  assert.ok(first);
  assert.equal(scanner.scans, 1);
  assert.equal(second, first);
  assert.equal(scanner.published.length, 1);
  forgetCodebaseMap("alice", SAMPLE.repoRoot);
});

test("ensureCodebaseMap rebuilds when the repository moved on", async () => {
  const scanner = fakeScanner(SAMPLE, { head: "head-2" });
  await ensureCodebaseMap("bob", scanner, { repoRoot: SAMPLE.repoRoot });
  const rebuilt = await ensureCodebaseMap("bob", scanner, { repoRoot: SAMPLE.repoRoot });
  assert.equal(scanner.scans, 2);
  assert.ok(rebuilt);
  forgetCodebaseMap("bob", SAMPLE.repoRoot);
});

test("ensureCodebaseMap keeps the agent touch counters across rebuilds", async () => {
  const scanner = fakeScanner(SAMPLE, { head: "head-1" });
  await ensureCodebaseMap("carol", scanner, { repoRoot: SAMPLE.repoRoot });
  await recordAgentTouches("carol", scanner, SAMPLE.repoRoot, ["src/core.ts"]);
  await ensureCodebaseMap("carol", scanner, { repoRoot: SAMPLE.repoRoot, force: true });
  const map = await ensureCodebaseMap("carol", scanner, { repoRoot: SAMPLE.repoRoot });
  assert.equal(map?.files.find((file) => file.path === "src/core.ts")?.agentTouches, 1);
  forgetCodebaseMap("carol", SAMPLE.repoRoot);
});

test("recordAgentTouches raises the heat of the touched file", async () => {
  const scanner = fakeScanner(SAMPLE, { head: "head-1" });
  const map = await ensureCodebaseMap("dave", scanner, { repoRoot: SAMPLE.repoRoot });
  const before = map?.heatmap.find((entry) => entry.path === "src/core.ts")?.heat ?? 0;
  await recordAgentTouches("dave", scanner, SAMPLE.repoRoot, ["src/core.ts"]);
  const after = map?.heatmap.find((entry) => entry.path === "src/core.ts")?.heat ?? 0;
  assert.ok(after > before, `${after} should be hotter than ${before}`);
  forgetCodebaseMap("dave", SAMPLE.repoRoot);
});

test("the context pack and the hotspots come from the same map", async () => {
  const scanner = fakeScanner(SAMPLE, { head: "head-1" });
  const pack = await getCodebaseContextPack("erin", scanner, SAMPLE.repoRoot);
  const hotspots = await getCodebaseHotspots("erin", scanner, SAMPLE.repoRoot, 1);
  assert.ok(pack?.text.includes("src/core.ts"));
  assert.equal(hotspots.length, 1);
  assert.equal(hotspots[0].path, "src/core.ts");
  forgetCodebaseMap("erin", SAMPLE.repoRoot);
});

test("maybeRefreshCodebaseMapOnGitChange only rebuilds when the head moved", async () => {
  const scanner = fakeScanner(SAMPLE, { head: "head-1" });
  await ensureCodebaseMap("frank", scanner, { repoRoot: SAMPLE.repoRoot });
  await maybeRefreshCodebaseMapOnGitChange("frank", scanner, SAMPLE.repoRoot);
  assert.equal(scanner.scans, 1);
  forgetCodebaseMap("frank", SAMPLE.repoRoot);
});

test("a published map is read back instead of rescanning when HEAD did not move", async () => {
  const stored = buildMapFromScan(SAMPLE, { repoRoot: SAMPLE.repoRoot });
  let scans = 0;
  const scanner: CodebaseScanner = {
    async scan(): Promise<CodebaseScan | null> {
      scans += 1;
      return SAMPLE;
    },
    async head(): Promise<string | undefined> {
      return "head-1";
    },
    async publish(): Promise<void> {},
    async readMap(): Promise<CodebaseMap | null> {
      return stored;
    },
    async listRepos(): Promise<CodebaseRepoOption[]> {
      return [];
    },
    async selectedRepo(): Promise<string | null> {
      return null;
    },
    async selectRepo(): Promise<void> {},
  };

  const map = await ensureCodebaseMap("gina", scanner, { repoRoot: SAMPLE.repoRoot });
  assert.equal(scans, 0);
  assert.equal(map?.repoHash, stored.repoHash);
  forgetCodebaseMap("gina", SAMPLE.repoRoot);
});

test("a published map is rebuilt when HEAD moved on", async () => {
  const stored = buildMapFromScan(SAMPLE, { repoRoot: SAMPLE.repoRoot });
  let scans = 0;
  const scanner: CodebaseScanner = {
    async scan(): Promise<CodebaseScan | null> {
      scans += 1;
      return SAMPLE;
    },
    async head(): Promise<string | undefined> {
      return "head-2";
    },
    async publish(): Promise<void> {},
    async readMap(): Promise<CodebaseMap | null> {
      return stored;
    },
    async listRepos(): Promise<CodebaseRepoOption[]> {
      return [];
    },
    async selectedRepo(): Promise<string | null> {
      return null;
    },
    async selectRepo(): Promise<void> {},
  };

  await ensureCodebaseMap("henry", scanner, { repoRoot: SAMPLE.repoRoot });
  assert.equal(scans, 1);
  forgetCodebaseMap("henry", SAMPLE.repoRoot);
});

test("normalizeRepoPath turns workspace paths into repo-relative ones", () => {
  assert.equal(normalizeRepoPath("/workspace/demo/src/a.ts", "/workspace/demo"), "src/a.ts");
  assert.equal(normalizeRepoPath("/workspace/demo/src/a.ts"), "demo/src/a.ts");
  assert.equal(normalizeRepoPath("src/a.ts"), "src/a.ts");
  assert.equal(normalizeRepoPath("./src/a.ts"), "src/a.ts");
  assert.equal(normalizeRepoPath("/etc/passwd"), null);
  assert.equal(normalizeRepoPath("../outside.ts"), null);
  assert.equal(normalizeRepoPath(""), null);
});
