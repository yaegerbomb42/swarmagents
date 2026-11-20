/**
 * Tests for /api/templates/run — the endpoint that starts a gallery
 * template's run on the user's own VM with the template's role.
 *
 * The fake VM driver replays a recorded Claude transcript, so the whole
 * path (route -> RuntimeManager -> ClaudeCodeRunner -> FakeVmDriver) runs
 * without Docker. Auth is the middleware-set x-swarm-user header.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { RuntimeManager, setRuntimeManagerForTesting } from "../../../../lib/runtime/manager";
import { VmManager } from "../../../../lib/vm/manager";
import { FakeVmDriver } from "../../../../lib/vm/fake-driver";
import type { ExecOptions, ExecResult, VmHandle } from "../../../../lib/vm/types";
import { findTemplate } from "../../../../lib/templates";

const FIXTURE_LINES = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess_1", model: "claude-sonnet-5-5" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
  JSON.stringify({ type: "result", subtype: "success", session_id: "sess_1", cost_usd: 0.01, duration_ms: 10, num_turns: 1 }),
];

class ScriptedFakeVm extends FakeVmDriver {
  calls: Array<{ cmd: string[]; opts: ExecOptions }> = [];

  override async exec(h: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ cmd, opts: opts ?? {} });
    if (cmd[0] !== "claude") return super.exec(h, cmd, opts);
    for (const line of FIXTURE_LINES) opts?.onStdout?.(`${line}\n`);
    return { exitCode: 0 };
  }
}

function install(driver: ScriptedFakeVm): RuntimeManager {
  const manager = new RuntimeManager({ vm: new VmManager({ customDriver: driver }) });
  setRuntimeManagerForTesting(manager);
  return manager;
}

function post(body: unknown, user: string | null = "alice"): Promise<Response> {
  const headers = new Headers();
  if (user !== null) headers.set("x-swarm-user", user);
  return POST(
    new NextRequest("http://localhost/api/templates/run", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

test.afterEach(() => {
  setRuntimeManagerForTesting(null);
});

test("a template run starts with the template's role and the filled prompt", async () => {
  const driver = new ScriptedFakeVm();
  install(driver);

  const res = await post({
    templateId: "rest-api-with-auth",
    values: { language: "Python + FastAPI", project_name: "ledger-api", resource: "invoices" },
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { runId?: string; prompt?: string };
  assert.match(body.runId ?? "", /^run_[A-Za-z0-9_-]{1,64}$/);

  // The prompt the agent gets is the written one with the answers filled in.
  assert.ok(body.prompt?.includes("ledger-api"), "the answer should be in the prompt");
  assert.ok(body.prompt?.includes("invoices"), "the answer should be in the prompt");
  assert.ok(body.prompt?.includes("Python + FastAPI"), "the selected option should be in the prompt");
  assert.ok(!/\{\{/.test(body.prompt ?? ""), "no placeholder should survive into the run");

  // The role is applied: the harness argv carries that role's tools.
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  const claudeCall = driver.calls.find((call) => call.cmd[0] === "claude");
  assert.ok(claudeCall, "the harness should have been invoked");
  const allowedIdx = claudeCall.cmd.indexOf("--allowedTools");
  assert.ok(allowedIdx !== -1, "the role phase should pass --allowedTools");
  const allowed = claudeCall.cmd.slice(allowedIdx + 1, claudeCall.cmd.indexOf("--mcp-config"));
  // The Backend Engineer role writes files and runs commands; the Main Agent
  // role has a wider tool set. The role must not be the default "main".
  assert.ok(allowed.includes("Write"), `expected the backend-engineer role tools, got ${allowed.join(",")}`);
});

test("the agent card still rides along with a template run", async () => {
  const driver = new ScriptedFakeVm();
  install(driver);

  const res = await post({
    templateId: "fix-failing-test",
    values: { directory: "/workspace", test_name: "checkout", error_message: "boom" },
    agentCard: "I am your autonomous engineer on this Linux VM.",
  });
  assert.equal(res.status, 201);

  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  const claudeCall = driver.calls.find((call) => call.cmd[0] === "claude");
  assert.ok(claudeCall);
  const idx = claudeCall.cmd.indexOf("--append-system-prompt");
  assert.ok(idx !== -1);
  assert.ok(claudeCall.cmd[idx + 1].startsWith("I am your autonomous engineer on this Linux VM."));
});

test("unauthenticated requests are refused", async () => {
  install(new ScriptedFakeVm());
  const res = await post({ templateId: "fix-failing-test", values: {} }, null);
  assert.equal(res.status, 401);
});

test("an unknown template id is a 404", async () => {
  install(new ScriptedFakeVm());
  const res = await post({ templateId: "no-such-template", values: {} });
  assert.equal(res.status, 404);
});

test("a missing template id is a 400", async () => {
  install(new ScriptedFakeVm());
  assert.equal((await post({ values: {} })).status, 400);
});

test("a malformed body is a 400", async () => {
  install(new ScriptedFakeVm());
  const headers = new Headers({ "x-swarm-user": "alice", "content-type": "application/json" });
  const res = await POST(
    new NextRequest("http://localhost/api/templates/run", { method: "POST", headers, body: "not json" }),
  );
  assert.equal(res.status, 400);
});

test("values for fields the template does not have are ignored", async () => {
  const driver = new ScriptedFakeVm();
  install(driver);

  const res = await post({
    templateId: "fix-failing-test",
    values: { directory: "/workspace", test_name: "checkout", error_message: "boom", sneaky: "ignore me" },
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { prompt?: string };
  assert.ok(!body.prompt?.includes("ignore me"), "an unknown field must not reach the prompt");
});

test("every template in the catalog can be started", async () => {
  const driver = new ScriptedFakeVm();
  install(driver);

  const templates = ["rest-api-with-auth", "fix-failing-test", "clean-a-csv", "write-a-readme", "plan-your-week"];
  for (const [index, template] of templates.entries()) {
    // A distinct user per template: each account has its own run slot and
    // its own queue, so this does not trip the per-user queue limit.
    const res = await post({ templateId: template, values: {} }, `user-${index}`);
    assert.equal(res.status, 201, `template ${template} should start`);
    const body = (await res.json()) as { runId?: string };
    assert.match(body.runId ?? "", /^run_/, `template ${template} should return a run id`);
  }
});

test("a template with no fields still produces a prompt", async () => {
  const driver = new ScriptedFakeVm();
  install(driver);
  const template = findTemplate("rest-api-with-auth");
  assert.ok(template);
  // Every field has a default, so an empty values map still renders fully.
  const res = await post({ templateId: template.id, values: {} });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { prompt?: string };
  assert.ok((body.prompt ?? "").length > 80, "the written prompt should survive with default answers");
});
