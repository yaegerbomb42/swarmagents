/**
 * End-to-end: fake VM + server-side LLM translation endpoint + OpenAI-format
 * mock provider.
 *
 * The full loop is exercised: POST /api/runtime/tasks -> RuntimeManager (with
 * a router whose only provider is an openai-format mock hosted on a local HTTP
 * server) -> the run's env points ANTHROPIC_BASE_URL at
 * /api/runtime/llm/<runToken>/v1 -> a fake claude binary (acting as Claude
 * Code inside the VM) calls that endpoint twice - first non-streaming with a
 * tool definition (expects a tool_use back), then streaming with the
 * tool_result - and prints the resulting stream-json transcript. The harness
 * processes it, so the run must finish successfully with a tool call
 * recorded. The mock provider asserts the wire format is OpenAI chat
 * completions, never Anthropic Messages, and that the provider key appears
 * only upstream (never in the VM env).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { POST as tasksPOST } from "./tasks/route";
import { GET as streamGET } from "./stream/[runId]/route";
import { POST as messagesPOST } from "./llm/[runToken]/v1/messages/route";
import { RuntimeManager, setRuntimeManagerForTesting } from "../../../lib/runtime/manager";
import { VmManager } from "../../../lib/vm/manager";
import { FakeVmDriver } from "../../../lib/vm/fake-driver";
import { Router } from "../../../lib/providers/router";
import type { ProviderConfig } from "../../../lib/providers/types";
import { signRunToken, verifyRunToken } from "../../../lib/runtime/run-token";
import type { ExecOptions, ExecResult, VmHandle } from "../../../lib/vm/types";
import type { SequencedEvent } from "../../../lib/telemetry/bus";

const USER = "e2e-llm";
const MOCK_MODEL = "mock-openai-model";
const MOCK_KEY = "sk-mock-e2e";

interface MockCall {
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

/** OpenAI-format mock provider: non-streaming tool_calls + streaming text SSE. */
function startMockOpenAIProvider(): Promise<{ server: Server; calls: MockCall[] }> {
  const calls: MockCall[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(raw) as Record<string, unknown>;
      calls.push({ url: req.url ?? "", authorization: req.headers.authorization ?? null, body });

      if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-s1",
            model: MOCK_MODEL,
            choices: [{ index: 0, delta: { role: "assistant", content: "listed" } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: { content: " the files" } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 12, completion_tokens: 3 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          model: MOCK_MODEL,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_x1",
                    type: "function",
                    function: { name: "Bash", arguments: '{"command":"ls"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, calls }));
  });
}

async function postMessages(runToken: string, body: unknown): Promise<Response> {
  const req = new NextRequest(`http://localhost/api/runtime/llm/${runToken}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return messagesPOST(req, { params: Promise.resolve({ runToken }) });
}

async function readAll(res: Response): Promise<string> {
  if (!res.body) throw new Error("no response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

/** Fake Claude Code inside the VM: talks to the translation endpoint via HTTP. */
async function fakeClaudeLoop(
  env: Record<string, string>,
  onStdout: (chunk: string) => void,
  onStderr: (chunk: string) => void,
): Promise<number> {
  try {
    const base = env.ANTHROPIC_BASE_URL;
    const match = /\/llm\/([^/]+)$/.exec(base ?? "");
    if (!match || !env.ANTHROPIC_AUTH_TOKEN) {
      throw new Error(`expected LLM proxy env, got base=${base} token=${env.ANTHROPIC_AUTH_TOKEN}`);
    }
    const runToken = match[1];
    const model = env.ANTHROPIC_MODEL ?? MOCK_MODEL;

    // Call 1: non-streaming, ask for a tool use.
    const call1 = await postMessages(runToken, {
      model,
      max_tokens: 256,
      messages: [{ role: "user", content: "list the repo files using Bash" }],
      tools: [
        {
          name: "Bash",
          description: "Run a shell command",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
      stream: false,
    });
    if (call1.status !== 200) {
      throw new Error(`LLM call 1 failed: ${call1.status} ${await call1.text()}`);
    }
    const c1 = (await call1.json()) as { content?: Array<Record<string, unknown>> };
    const toolUse = c1.content?.find((b) => b.type === "tool_use");
    if (!toolUse || typeof toolUse.id !== "string" || typeof toolUse.name !== "string") {
      throw new Error(`expected a tool_use block in call 1, got ${JSON.stringify(c1)}`);
    }

    // Call 2: streaming, feed the tool_result back.
    const call2 = await postMessages(runToken, {
      model,
      max_tokens: 256,
      messages: [
        { role: "user", content: "list the repo files using Bash" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: toolUse.id, name: toolUse.name, input: toolUse.input }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: toolUse.id, content: "app\nlib", is_error: false },
          ],
        },
      ],
      stream: true,
    });
    if (call2.status !== 200) {
      throw new Error(`LLM call 2 failed: ${call2.status} ${await call2.text()}`);
    }
    const sse = await readAll(call2);
    if (!sse.includes("message_stop")) {
      throw new Error(`stream ended before message_stop:\n${sse}`);
    }

    const transcript = [
      { type: "system", subtype: "init", session_id: "sess_llm_e2e", model },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: toolUse.id, name: toolUse.name, input: toolUse.input }],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: toolUse.id, content: "app\nlib", is_error: false },
          ],
        },
      },
      { type: "assistant", message: { content: [{ type: "text", text: "listed the files with Bash" }] } },
      { type: "result", subtype: "success", session_id: "sess_llm_e2e", cost_usd: 0.01, duration_ms: 50, num_turns: 2 },
    ];
    onStdout(transcript.map((line) => JSON.stringify(line)).join("\n") + "\n");
    return 0;
  } catch (error) {
    onStderr(`fake claude failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** Driver that runs fakeClaudeLoop in-process when the claude binary is invoked. */
class LlmFakeVmDriver extends FakeVmDriver {
  claudeEnv: Record<string, string> | null = null;

  constructor(
    private readonly claudeBin: string,
    private readonly loop: (env: Record<string, string>, onStdout: (c: string) => void, onStderr: (c: string) => void) => Promise<number>,
  ) {
    super({ replayClaude: false });
  }

  override async exec(handle: VmHandle, cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    if (cmd[0] !== this.claudeBin) return super.exec(handle, cmd, opts);
    this.claudeEnv = { ...(opts.env as Record<string, string> | undefined) };
    const exitCode = await this.loop(this.claudeEnv!, opts.onStdout ?? (() => {}), opts.onStderr ?? (() => {}));
    return { exitCode };
  }
}

function taskRequest(prompt: string): NextRequest {
  return new NextRequest("http://localhost/api/runtime/tasks", {
    method: "POST",
    headers: new Headers({ "x-swarm-user": USER }),
    body: JSON.stringify({ prompt }),
  });
}

function streamRequest(runId: string): NextRequest {
  return new NextRequest(`http://localhost/api/runtime/stream/${runId}`, {
    headers: new Headers({ "x-swarm-user": USER }),
  });
}

async function readUntil(res: Response, terminal: string): Promise<SequencedEvent[]> {
  assert.ok(res.body, "SSE response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: SequencedEvent[] = [];
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!data) continue;
        const event = JSON.parse(data.slice("data: ".length)) as SequencedEvent;
        events.push(event);
        if (event.type === terminal) return events;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new Error(`SSE stream ended before ${terminal}`);
}

test.afterEach(() => {
  setRuntimeManagerForTesting(null);
});

test("fake VM completes a tool-calling run through the LLM gateway to an OpenAI-format mock provider", async () => {
  const { server, calls } = await startMockOpenAIProvider();
  const port = (server.address() as AddressInfo).port;
  const claudeBin = "/tmp/llm-e2e/claude-fake";
  const prev = {
    secret: process.env.SWARM_SESSION_SECRET,
    base: process.env.SWARM_VM_LLM_BASE_URL,
    bin: process.env.CLAUDE_BIN,
  };
  try {
    process.env.SWARM_SESSION_SECRET = "e2e-session-secret";
    process.env.SWARM_VM_LLM_BASE_URL = "http://llm.test";
    process.env.CLAUDE_BIN = claudeBin;

    const provider: ProviderConfig = {
      id: "mock-openai",
      kind: "openai",
      baseUrl: `http://127.0.0.1:${port}`,
      models: { balanced: MOCK_MODEL },
      keys: [MOCK_KEY],
      rank: 0,
    };
    const router = new Router({ providers: [provider] });
    const driver = new LlmFakeVmDriver(claudeBin, fakeClaudeLoop);
    setRuntimeManagerForTesting(new RuntimeManager({ vm: new VmManager({ customDriver: driver }), router }));

    const post = await tasksPOST(taskRequest("please list the repo files"));
    assert.equal(post.status, 201);
    const { runId } = (await post.json()) as { runId: string };

    const res = await streamGET(streamRequest(runId), { params: Promise.resolve({ runId }) });
    const events = await readUntil(res, "run.finished");

    const types = events.map((event) => event.type);
    assert.equal(types[0], "run.created");
    assert.equal(types[types.length - 1], "run.finished");
    assert.ok(!types.includes("run.error"), `run errored: ${JSON.stringify(events)}`);

    const finished = events[events.length - 1] as unknown as { exitCode?: number };
    assert.equal(finished.exitCode, 0);

    // The conversation had a tool call, its result, and a final answer.
    const toolCall = events.find((e) => e.type === "tool.call") as unknown as { name?: string } | undefined;
    assert.ok(toolCall, "no tool.call event");
    assert.equal(toolCall.name, "Bash");
    assert.ok(events.some((e) => e.type === "tool.result"));
    assert.ok(events.some((e) => e.type === "assistant.text"));

    // The provider saw only OpenAI-format requests, translated with the
    // provider's model, and got the real key via a Bearer header.
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.url, "/v1/chat/completions");
      assert.equal(call.authorization, `Bearer ${MOCK_KEY}`);
      assert.equal(call.body.model, MOCK_MODEL);
    }
    const first = calls[0];
    const tools = first.body.tools as Array<Record<string, unknown>> | undefined;
    assert.ok(Array.isArray(tools) && tools.length === 1);
    assert.equal(tools![0].type, "function");
    assert.equal((tools![0].function as Record<string, unknown>).name, "Bash");
    assert.deepEqual(first.body.messages, [
      { role: "user", content: "list the repo files using Bash" },
    ]);
    const second = calls[1];
    assert.equal(second.body.stream, true);
    const secondMessages = second.body.messages as Array<Record<string, unknown>>;
    assert.ok(secondMessages.some((m) => m.role === "tool" && m.tool_call_id === "call_x1"));

    // The provider's real key never entered the VM: the VM saw only the
    // per-run token as the auth credential, scoped to this user and run.
    assert.ok(driver.claudeEnv);
    assert.ok(!JSON.stringify(driver.claudeEnv).includes(MOCK_KEY));
    const vmBase = driver.claudeEnv!.ANTHROPIC_BASE_URL!;
    const vmToken = driver.claudeEnv!.ANTHROPIC_AUTH_TOKEN!;
    assert.ok(vmBase.startsWith("http://llm.test/api/runtime/llm/"));
    assert.ok(!vmBase.endsWith("/v1"), "Claude Code appends /v1 itself");
    const runToken = vmBase.split("/llm/")[1]!;
    assert.equal(vmToken, runToken, "AUTH_TOKEN equals the URL token");
    assert.equal(driver.claudeEnv!.ANTHROPIC_MODEL, MOCK_MODEL);

    // The token was valid while the run was live (the fake claude's calls
    // only succeeded through it). The run has since finalized, which revokes
    // the token: it dies exactly when the run does (revocation is keyed by
    // runId, so even a fresh token for this run is dead).
    assert.equal(verifyRunToken(runToken, { userId: USER, runId }), null);
    assert.equal(verifyRunToken(signRunToken(USER, runId), { userId: USER, runId }), null);
    // Sanity: a token for a different run still verifies, so the rejection
    // above is this run's revocation, not broken machinery.
    assert.ok(verifyRunToken(signRunToken(USER, "run_other"), { userId: USER, runId: "run_other" }));
  } finally {
    server.close();
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
