/**
 * End-to-end integration for the in-VM PreToolUse hook.
 *
 * This runs the *real* hook script (vm-image/hooks/pre-tool-use.mjs) against a
 * local HTTP server wired to the real approval coordinator
 * (lib/harness/tool-approval.ts) and ApprovalStore. The "CLI" is a faithful
 * fake: it invokes the hook and only performs the tool's effect when the hook
 * returns allow. That is enough to prove the security property the bug was
 * about — the effect must not happen while the approval is pending, and must
 * never happen on deny or timeout.
 *
 * No real `sudo`/`rm` is executed: `sudo touch <marker>` is classified "ask"
 * by the real classifier and the fake CLI writes the marker as its effect.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluateToolApproval } from "./tool-approval";
import { ApprovalStore } from "./approvals";
import type { ApprovalTicket, TelemetryEvent } from "./types";
import type { AddressInfo } from "node:net";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, "../../vm-image/hooks/pre-tool-use.mjs");
const TOKEN = "rt1.test-token";

type Mode = "approve" | "deny" | "pending" | "timeout";

interface Harness {
  url: string;
  events: TelemetryEvent[];
  approvals: string[];
  mode: Mode;
  store: ApprovalStore;
  close: () => Promise<void>;
}

async function startHarness(mode: Mode, ttlMs = 60_000): Promise<Harness> {
  const store = new ApprovalStore({ ttlMs });
  const events: TelemetryEvent[] = [];
  const approvals: string[] = [];
  const state: Harness = {
    url: "",
    events,
    approvals,
    mode,
    store,
    close: async () => {},
  };

  const server = http.createServer((req, res) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      text += c;
    });
    req.on("end", () => {
      void (async () => {
        if ((req.headers.authorization ?? "") !== `Bearer ${TOKEN}`) {
          res.statusCode = 401;
          res.end(JSON.stringify({ decision: "deny", reason: "bad token" }));
          return;
        }
        let body: any;
        try {
          body = JSON.parse(text);
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ decision: "deny", reason: "bad json" }));
          return;
        }

        const createApproval = (ask: { toolName: string; action: string; reason: string }): ApprovalTicket => {
          const approval = store.create({
            runId: "run_e2e",
            userId: "alice",
            toolName: ask.toolName,
            action: ask.action,
            reason: ask.reason,
          });
          approvals.push(approval.id);
          if (state.mode === "approve") {
            setTimeout(() => store.resolve(approval.id, "approved"), 30);
          } else if (state.mode === "deny") {
            setTimeout(() => store.resolve(approval.id, "denied"), 30);
          }
          // "pending" / "timeout": the test resolves it or the TTL expires.
          return {
            id: approval.id,
            expiresAt: approval.expiresAt,
            timedOut: () => store.get(approval.id)?.timedOut === true,
            verdict: store.waitFor(approval.id),
          };
        };

        const result = await evaluateToolApproval({
          toolName: String(body.tool_name ?? ""),
          input: body.tool_input ?? {},
          emit: (e) => events.push(e),
          createApproval,
        });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
      })().catch((error) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ decision: "deny", reason: String(error) }));
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${port}/api/runtime/approvals/hook`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

interface HookResult {
  decision: "allow" | "deny";
  reason?: string;
  code: number | null;
}

/** Run the real hook exactly the way Claude Code would: JSON on stdin. */
function runHook(
  url: string,
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env,
        SWARM_APPROVAL_URL: url,
        SWARM_APPROVAL_TOKEN: TOKEN,
        SWARM_APPROVAL_TIMEOUT_MS: "5000",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve({
          decision: parsed.hookSpecificOutput.permissionDecision,
          reason: parsed.hookSpecificOutput.permissionDecisionReason,
          code,
        });
      } catch {
        reject(new Error(`hook produced no JSON decision (code ${code}): ${stdout} ${stderr}`));
      }
    });
    child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s_e2e", ...payload }));
  });
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarm-hook-e2e-"));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await sleep(5);
  }
}

test("ask does not execute while pending; approve then executes", async () => {
  const h = await startHarness("pending");
  const dir = tmpDir();
  const marker = path.join(dir, "marker");
  try {
    const hookPromise = runHook(h.url, {
      tool_name: "Bash",
      tool_input: { command: `sudo touch ${marker}` },
    });

    await until(() => h.events.some((e) => e.type === "approval.requested"));
    assert.deepEqual(h.approvals.length, 1);
    // The CLI is blocked in the hook: the command has not run.
    assert.equal(fs.existsSync(marker), false);
    assert.equal(h.events.some((e) => e.type === "tool.started"), false);

    // The human approves. Only now may the fake CLI perform the effect.
    h.store.resolve(h.approvals[0], "approved");
    const result = await hookPromise;
    assert.equal(result.decision, "allow");
    assert.equal(result.code, 0);

    // The fake CLI executes only after the hook returned allow.
    if (result.decision === "allow") fs.writeFileSync(marker, "ran");
    assert.equal(fs.existsSync(marker), true);

    const requested = h.events.findIndex((e) => e.type === "approval.requested");
    const started = h.events.findIndex((e) => e.type === "tool.started");
    assert.ok(requested >= 0 && started > requested, "approval.requested must precede tool.started");
  } finally {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deny blocks the command: the marker never appears", async () => {
  const h = await startHarness("deny");
  const dir = tmpDir();
  const marker = path.join(dir, "marker");
  try {
    const result = await runHook(h.url, {
      tool_name: "Bash",
      tool_input: { command: `sudo touch ${marker}` },
    });

    assert.equal(result.decision, "deny");
    assert.match(result.reason ?? "", /denied|blocked/i);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(h.events.some((e) => e.type === "tool.started"), false);
  } finally {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("timeout (300s default in prod, short TTL here) defaults to deny", async () => {
  const h = await startHarness("timeout", 100);
  const dir = tmpDir();
  const marker = path.join(dir, "marker");
  try {
    const result = await runHook(h.url, {
      tool_name: "Bash",
      tool_input: { command: `sudo touch ${marker}` },
    });

    assert.equal(result.decision, "deny");
    assert.match(result.reason ?? "", /timed out/i);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(h.events.some((e) => e.type === "approval.timeout"), true);
    assert.equal(h.events.some((e) => e.type === "tool.started"), false);
  } finally {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a deny verdict blocks reading a secret file", async () => {
  const h = await startHarness("approve");
  const dir = tmpDir();
  const leaked = path.join(dir, "leaked");
  try {
    const result = await runHook(h.url, {
      tool_name: "Read",
      tool_input: { file_path: "/etc/passwd" },
    });

    assert.equal(result.decision, "deny");
    assert.match(result.reason ?? "", /credential/i);
    const decision: string = result.decision;
    if (decision === "allow") fs.writeFileSync(leaked, "secret contents");
    assert.equal(fs.existsSync(leaked), false);
    assert.equal(h.events.some((e) => e.type === "tool.started"), false);
  } finally {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a benign call is allowed and executes", async () => {
  const h = await startHarness("approve");
  const dir = tmpDir();
  const marker = path.join(dir, "marker");
  try {
    const result = await runHook(h.url, {
      tool_name: "Bash",
      tool_input: { command: "touch marker" },
    });
    assert.equal(result.decision, "allow");
    if (result.decision === "allow") fs.writeFileSync(marker, "ran");
    assert.equal(fs.existsSync(marker), true);
    assert.equal(h.events.some((e) => e.type === "tool.started"), true);
  } finally {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the hook fails closed without a run token (manually launched claude)", async () => {
  const result = await runHook("http://127.0.0.1:1/api/runtime/approvals/hook", {
    tool_name: "Bash",
    tool_input: { command: "touch marker" },
  }, { SWARM_APPROVAL_URL: "", SWARM_APPROVAL_TOKEN: "" });
  assert.equal(result.decision, "deny");
  assert.match(result.reason ?? "", /not configured/i);
});

test("the hook fails closed when the approval service is unreachable", async () => {
  const result = await runHook("http://127.0.0.1:1/api/runtime/approvals/hook", {
    tool_name: "Bash",
    tool_input: { command: "touch marker" },
  });
  assert.equal(result.decision, "deny");
  assert.match(result.reason ?? "", /could not reach/i);
});

test("managed settings register the hook and no longer blanket-allow risky tools", () => {
  const settings = JSON.parse(
    fs.readFileSync(path.resolve(HERE, "../../vm-image/managed-settings.json"), "utf8"),
  );
  assert.equal(settings.disableAllHooks, false);

  const preToolUse = settings.hooks?.PreToolUse;
  assert.ok(Array.isArray(preToolUse) && preToolUse.length === 1);
  assert.equal(preToolUse[0].matcher, "*");
  assert.equal(preToolUse[0].hooks[0].type, "command");
  assert.equal(preToolUse[0].hooks[0].command, "/usr/local/bin/swarm-approval-hook");
  // The CLI timeout must outlast the harness approval TTL so its deny wins.
  assert.ok(preToolUse[0].hooks[0].timeout >= 330);

  const allow: string[] = settings.permissions?.allow ?? [];
  for (const risky of ["Bash", "Read", "Edit", "Write", "WebFetch", "NotebookEdit"]) {
    assert.equal(allow.includes(risky), false, `${risky} must not be blanket-allowed`);
  }
  // The hook itself must be shipped and executable in the image.
  assert.equal(fs.existsSync(HOOK), true);
});
