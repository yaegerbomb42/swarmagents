/**
 * VM-only policy tests (lib/harness/vm-only.ts).
 *
 * The policy is the server-side guarantee that the agent can only act inside
 * the user's VM. These tests pin the escape hatches it must refuse — host
 * paths, the container runtime socket, host-local network addresses and host
 * namespaces — and the ordinary VM paths it must allow.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { classifyHostTarget } from "./vm-only";

interface Case {
  name: string;
  tool: string;
  input: unknown;
  denied: boolean;
}

const CASES: Case[] = [
  // ── allowed: ordinary work inside the VM ─────────────────────────────────
  { name: "workspace file read", tool: "Read", input: { file_path: "/workspace/game/index.html" }, denied: false },
  { name: "tmp write", tool: "Write", input: { file_path: "/tmp/out.txt", content: "hi" }, denied: false },
  { name: "home path", tool: "Edit", input: { file_path: "/home/agent/app.ts", old_string: "a", new_string: "b" }, denied: false },
  { name: "shell in workspace", tool: "Bash", input: { command: "ls -la /workspace && npm test" }, denied: false },
  { name: "curl to a public host", tool: "Bash", input: { command: "curl -s https://registry.npmjs.org/react" }, denied: false },
  { name: "browser to the public web", tool: "browser_navigate", input: { url: "https://example.com/docs" }, denied: false },
  { name: "non-path glob", tool: "Glob", input: { pattern: "**/*.ts" }, denied: false },
  { name: "empty input", tool: "Bash", input: undefined, denied: false },

  // ── denied: host filesystem escapes ──────────────────────────────────────
  { name: "host mount path", tool: "Read", input: { file_path: "/host/etc/passwd" }, denied: true },
  { name: "mnt host path", tool: "Write", input: { file_path: "/mnt/host/workspace/x", content: "x" }, denied: true },
  { name: "proc 1 root", tool: "Bash", input: { command: "cat /proc/1/root/etc/shadow" }, denied: true },
  { name: "docker socket path", tool: "Read", input: { path: "/var/run/docker.sock" }, denied: true },
  { name: "run host dir", tool: "Bash", input: { command: "ls /run/host/proc" }, denied: true },
  { name: "windows docker pipe", tool: "Read", input: { file_path: "\\\\.\\pipe\\docker" }, denied: true },

  // ── denied: host-local network services ──────────────────────────────────
  { name: "browser to docker host", tool: "browser_navigate", input: { url: "http://host.docker.internal:3000" }, denied: true },
  { name: "fetch metadata bridge", tool: "WebFetch", input: { url: "http://172.17.0.1/admin" }, denied: true },
  { name: "curl gateway", tool: "Bash", input: { command: "curl http://gateway.docker.internal:8080/health" }, denied: true },
  { name: "host key", tool: "SomeTool", input: { host: "host.containers.internal" }, denied: true },
  { name: "host with credentials and port", tool: "SomeTool", input: { endpoint: "http://user:pw@host.docker.internal:9000" }, denied: true },

  // ── denied: entering host namespaces ─────────────────────────────────────
  { name: "nsenter", tool: "Bash", input: { command: "nsenter -t 1 -m ls /" }, denied: true },
  { name: "nsenter after env", tool: "Bash", input: { script: "set -e; nsenter -t 1 -n ip a" }, denied: true },
];

for (const c of CASES) {
  test(`vm-only: ${c.denied ? "deny" : "allow"} — ${c.name}`, () => {
    const verdict = classifyHostTarget(c.tool, c.input);
    if (c.denied) {
      assert.ok(verdict, `expected ${c.tool} ${JSON.stringify(c.input)} to be denied`);
      assert.equal(verdict.level, "deny");
      assert.match(verdict.reason, /VM-only policy/);
      assert.match(verdict.reason, /inside the user's VM/);
    } else {
      assert.equal(verdict, null);
    }
  });
}

test("vm-only: extra host aliases are configurable", () => {
  assert.equal(classifyHostTarget("Bash", { command: "curl http://box.lan:8080" }), null);
  const verdict = classifyHostTarget("Bash", { command: "curl http://box.lan:8080" }, { extraHosts: ["box.lan"] });
  assert.ok(verdict);
  assert.match(verdict.reason, /box\.lan/);
});

test("vm-only: denial explains which path marker was hit", () => {
  const verdict = classifyHostTarget("Read", { file_path: "/host/secrets" });
  assert.ok(verdict);
  assert.match(verdict.reason, /\/host\//);
});

test("vm-only: denial explains which host address was hit", () => {
  const verdict = classifyHostTarget("Bash", { command: "curl https://172.18.0.1:443/x" });
  assert.ok(verdict);
  assert.match(verdict.reason, /172\.18\.0\.1/);
});

test("vm-only: a string input is scanned like a command", () => {
  assert.equal(classifyHostTarget("Bash", "cat /workspace/README.md"), null);
  const verdict = classifyHostTarget("Bash", "cat /host/etc/passwd");
  assert.ok(verdict);
  assert.equal(verdict.level, "deny");
});
