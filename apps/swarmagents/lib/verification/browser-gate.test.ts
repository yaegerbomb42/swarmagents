import test from "node:test";
import assert from "node:assert/strict";
import type { BrowserControl } from "../browser/manager";
import {
  createBrowserControlBackend,
  parseBrowserGateScript,
  runBrowserGate,
  runRepoBrowserGate,
  type BrowserGateBackend,
} from "./browser-gate";

test("parseBrowserGateScript parses YAML and JSON step lists", () => {
  const yaml = [
    "name: home-smoke",
    "steps:",
    "  - action: open",
    '    url: "${URL}/"',
    "  - action: expect_text",
    '    text: "SwarmAgents"',
    "  - action: expect_no_console_errors",
  ].join("\n");
  const parsed = parseBrowserGateScript(yaml);
  assert.equal(parsed.name, "home-smoke");
  assert.equal(parsed.steps.length, 3);
  assert.deepEqual(parsed.steps[0], { action: "open", url: "${URL}/" });

  const jsonParsed = parseBrowserGateScript(
    JSON.stringify({ steps: [{ action: "open", url: "https://example.com" }, { action: "expect_nonempty" }] }),
  );
  assert.equal(jsonParsed.steps.length, 2);
});

test("runBrowserGate passes default smoke steps and catches console errors", async () => {
  const mkBackend = (errors: Array<{ type: string; text: string }>): BrowserGateBackend => ({
    name: "fake",
    async open() {},
    async click() {},
    async type() {},
    async snapshot() {
      return "Rendered workspace dashboard with live agent status and controls.";
    },
    async console() {
      return errors;
    },
    async close() {},
  });

  const ok = await runBrowserGate(
    { name: "smoke", url: "http://127.0.0.1:3000" },
    { cwd: "/workspace" },
    mkBackend([]),
  );
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.tests?.passed, 4);

  const bad = await runBrowserGate(
    { name: "smoke", url: "http://127.0.0.1:3000" },
    { cwd: "/workspace" },
    mkBackend([{ type: "error", text: "Uncaught TypeError" }]),
  );
  assert.equal(bad.exitCode, 1);
  assert.match(bad.failures[0]?.message ?? "", /Uncaught TypeError/);
});

test("runBrowserGate blocks relative script path escapes and bridges BrowserControl", async () => {
  const escaped = await runBrowserGate(
    { name: "bad-script", script: "../../etc/passwd" },
    { cwd: "/workspace/repo", readScript: async () => "" },
    undefined,
  );
  assert.equal(escaped.exitCode, 1);
  assert.match(escaped.failures[0]?.message ?? "", /escapes workspace/);

  const navigated: string[] = [];
  const fakeControl: BrowserControl = {
    async navigate(_runId, url) {
      navigated.push(url);
      return { ok: true, url, title: "App" };
    },
    async screenshot() {
      return { ok: true, frameId: 1, width: 1280, height: 800 };
    },
    async act() {
      return { ok: true, url: "https://example.com" };
    },
    async evaluate(_runId, expr) {
      if (expr.includes("querySelector")) return { ok: true, value: true };
      return { ok: true, value: "Substantial visible application content rendered on screen." };
    },
    async getDiagnostics() {
      return [];
    },
    async getFrame() {
      return null;
    },
    async close() {},
  };

  const backend = createBrowserControlBackend(fakeControl, "run-1");
  const res = await runBrowserGate(
    { name: "control", url: "https://example.com", script: "smoke.yaml" },
    {
      cwd: "/workspace/repo",
      readScript: async () => "steps:\n  - action: open\n    url: ${URL}\n  - action: expect_selector\n    selector: \"#app\"\n  - action: expect_nonempty\n",
    },
    backend,
  );
  assert.equal(res.exitCode, 0);
  assert.deepEqual(navigated, ["https://example.com"]);
});

test("runRepoBrowserGate skips cleanly when absent and returns fail summary when a step fails", async () => {
  const absent = await runRepoBrowserGate(
    async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    "/workspace/repo",
    () => {
      throw new Error("should not construct backend when no script exists");
    },
  );
  assert.equal(absent, null);

  const failing = await runRepoBrowserGate(
    async (cmd) => {
      const joined = cmd.join(" ");
      if (joined.includes("for f in .swarm/browser-gate")) {
        return { exitCode: 0, stdout: ".swarm/browser-gate.json", stderr: "" };
      }
      if (cmd[0] === "cat") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ steps: [{ action: "open", url: "${URL}" }, { action: "expect_nonempty" }] }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    "/workspace/repo",
    () => ({
      name: "fake",
      async open() {},
      async click() {},
      async type() {},
      async snapshot() {
        return "blank";
      },
      async console() {
        return [];
      },
      async close() {},
    }),
    "http://127.0.0.1:3000",
  );
  assert.ok(failing);
  assert.equal(failing.passed, false);
  assert.equal(failing.badge, "fail");
  assert.match(failing.remediationPrompt ?? "", /Page looks empty/);
});
