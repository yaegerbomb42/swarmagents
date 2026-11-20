import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codebaseMcpServerSource } from "./codebase-mcp-source";

interface Rpc {
  jsonrpc: string;
  id?: number;
  result?: any;
  error?: { code: number; message: string };
}

function repoHash(repoRoot: string): string {
  return crypto.createHash("sha1").update(path.resolve(repoRoot)).digest("hex").slice(0, 16);
}

/** Run the MCP server against a fake map and answer the given requests. */
async function ask(requests: unknown[], repoRoot: string): Promise<Rpc[]> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-mcp-"));
  const mapDir = path.join(home, ".swarm", "codebase", repoHash(repoRoot));
  fs.mkdirSync(mapDir, { recursive: true });
  fs.writeFileSync(
    path.join(mapDir, "map.json"),
    JSON.stringify({
      version: 1,
      repoRoot,
      repoName: "demo",
      repoHash: repoHash(repoRoot),
      generatedAt: new Date(0).toISOString(),
      gitHead: "head-1",
      buildMs: 12,
      files: [],
      languages: { TypeScript: 3 },
      entryPoints: ["src/index.ts"],
      buildCommands: ["npm run build"],
      testCommands: ["npm test"],
      conventions: { testFramework: "node:test" },
      topLevelModules: [{ path: "src", kind: "dir", purpose: "Source", files: 3, bytes: 100 }],
      contextPack: {
        repoRoot,
        repoName: "demo",
        repoHash: repoHash(repoRoot),
        generatedAt: new Date(0).toISOString(),
        languages: { TypeScript: 3 },
        entryPoints: ["src/index.ts"],
        buildCommands: ["npm run build"],
        testCommands: ["npm test"],
        topLevelModules: [],
        keyFiles: [{ path: "src/index.ts", fanIn: 3 }],
        conventions: {},
        tokenEstimate: 42,
        text: "# Codebase context: demo",
      },
      heatmap: [
        { path: "src/index.ts", churn90d: 10, bytes: 100, fanIn: 3, agentTouches: 1, heat: 0.9 },
        { path: "src/other.ts", churn90d: 1, bytes: 50, fanIn: 0, agentTouches: 0, heat: 0.2 },
      ],
    }),
  );

  const serverPath = path.join(home, "codebase-server.mjs");
  fs.writeFileSync(serverPath, codebaseMcpServerSource(), "utf8");

  const child = spawn("node", [serverPath], {
    env: { ...process.env, HOME: home, SWARM_CODEBASE_REPO_ROOT: repoRoot },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const replies: Rpc[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        replies.push(JSON.parse(line) as Rpc);
      } catch {
        // ignore noise
      }
    }
  });

  for (const request of requests) {
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }
  // Poll for replies instead of a fixed sleep: cold `node` startup can take
  // ~850 ms in this VM, well past the old 400 ms wait, and the test flaked
  // whenever the server had not answered yet. Wait until every request has
  // a reply (or a 5 s deadline), so slow starts pass and a hung server
  // still fails fast instead of hanging the suite.
  const deadline = Date.now() + 5000;
  while (replies.length < requests.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  fs.rmSync(home, { recursive: true, force: true });
  return replies;
}

test("the codebase MCP server lists its two tools", async () => {
  const replies = await ask(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ],
    "/workspace/demo",
  );
  const list = replies.find((reply) => reply.id === 2);
  const names = (list?.result?.tools ?? []).map((tool: { name: string }) => tool.name);
  assert.deepEqual(names, ["codebase_map_get", "codebase_hotspots"]);
});

test("codebase_map_get returns the context pack", async () => {
  const replies = await ask(
    [{ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "codebase_map_get", arguments: {} } }],
    "/workspace/demo",
  );
  const reply = replies.find((item) => item.id === 7);
  const payload = JSON.parse(reply?.result?.content?.[0]?.text ?? "{}");
  assert.equal(payload.ok, true);
  assert.equal(payload.repoName, "demo");
  assert.match(payload.contextPack, /# Codebase context: demo/);
  assert.deepEqual(payload.keyFiles, [{ path: "src/index.ts", fanIn: 3 }]);
});

test("codebase_hotspots returns the hottest files", async () => {
  const replies = await ask(
    [{ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "codebase_hotspots", arguments: { n: 1 } } }],
    "/workspace/demo",
  );
  const reply = replies.find((item) => item.id === 8);
  const payload = JSON.parse(reply?.result?.content?.[0]?.text ?? "{}");
  assert.equal(payload.ok, true);
  assert.equal(payload.hotspots.length, 1);
  assert.equal(payload.hotspots[0].path, "src/index.ts");
});
