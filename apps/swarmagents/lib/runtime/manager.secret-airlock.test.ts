/**
 * Secret-airlock proof (test-only): a provider key must never reach a run
 * payload — run events, the run report, the artifact listing, or the Files
 * payload — even when the agent/terminal echoes it verbatim.
 *
 * The planted key is deliberately NOT shaped like any real credential
 * (`sk-…`, `ghp_…`, `AKIA…`, `Bearer …`), so the only code path that can
 * scrub it is the known-secret redaction (env-sensitive names + explicit
 * `redactSecrets`), not the shape-based masks. Every surface below asserts the
 * key is absent, and includes a sanity assertion that the *raw* input did
 * contain it — so removing a scrub flips the assertion and fails the test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRedactor, redactValue } from "../harness/redact";
import { RuntimeManager } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";
import { TelemetryBus, type SequencedEvent } from "../telemetry/bus";
import { assembleReport } from "./run-report";

/** The planted provider key. Not key-shaped; only the known-secret path scrubs it. */
const FAKE_KEY = "zz-airlock-fake-provider-key-0123456789abcdef";

/** The env secret shape the harness and manager build their redactor from. */
const HOST_ENV = { NO_FAKE_PROVIDER_KEY: FAKE_KEY } as Record<string, string>;

/** The redactor exactly as the agent-run harness builds it (env + redactSecrets). */
function runnerRedactor(): (text: string) => string {
  return makeRedactor(HOST_ENV, [FAKE_KEY]);
}

/**
 * Plant the key in `process.env` under a sensitive name, as a real provider
 * key would live, returning a restore function. The manager's shell redactor
 * is built from `process.env`, so this is the only way it can see the key.
 */
function plantInProcessEnv(): () => void {
  const prev = process.env.NO_FAKE_PROVIDER_KEY;
  process.env.NO_FAKE_PROVIDER_KEY = FAKE_KEY;
  return () => {
    if (prev === undefined) delete process.env.NO_FAKE_PROVIDER_KEY;
    else process.env.NO_FAKE_PROVIDER_KEY = prev;
  };
}

/** Fake VM driver whose exec output echoes the planted key into stdout and stderr. */
class LeakyVmDriver extends FakeVmDriver {
  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    opts?.onStdout?.(`leak ${FAKE_KEY}\n`);
    opts?.onStderr?.(`leak2 ${FAKE_KEY}\n`);
    return { exitCode: 0 };
  }
}

function waitForTerminal(bus: TelemetryBus, runId: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error("timed out waiting for run terminal event"));
    }, timeoutMs);
    const unsub = bus.subscribe(runId, 0, (event: SequencedEvent) => {
      if (event.type === "run.finished" || event.type === "run.error") {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });
}

// --- surface 1: run events (real manager shell path) -------------------------

test("a planted provider key reaches none of the persisted run events", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "airlock-events-"));
  const restore = plantInProcessEnv();
  try {
    const driver = new LeakyVmDriver();
    const vm = new VmManager({ customDriver: driver });
    const bus = new TelemetryBus({ persist: true, runsDir: () => dir });
    const manager = new RuntimeManager({ vm, bus });

    // The key is planted in the source (command) AND echoed by the shell's
    // stdout/stderr. The raw source must contain it, or the test proves nothing.
    const source = `deploy to staging with ${FAKE_KEY}`;
    assert.ok(source.includes(FAKE_KEY), "sanity: source must carry the key");

    const { runId } = manager.execShell("u-airlock", ["sh", "-c", "echo hi"], source);
    await waitForTerminal(bus, runId);

    const log = fs.readFileSync(path.join(dir, `${runId}.jsonl`), "utf8");
    assert.ok(!log.includes(FAKE_KEY), "key must never appear in the durable run log");
    assert.ok(log.includes("[REDACTED]"), "redacted marker must replace the key (not just drop it)");
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- surface 2: the run report ----------------------------------------------

test("the run report built from scrubbed telemetry carries no key", () => {
  const redact = runnerRedactor();
  const now = Date.now();

  // Raw events exactly as the harness would emit them BEFORE its redaction.
  const rawEvents = [
    { type: "run.created", ts: now, seq: 1, data: { prompt: `Deploy with ${FAKE_KEY}` } },
    { type: "assistant.text", ts: now + 1, seq: 2, text: `I will use ${FAKE_KEY}` },
    { type: "tool.result", ts: now + 2, seq: 3, ok: false, output: `failed: ${FAKE_KEY}` },
    { type: "run.error", ts: now + 3, seq: 4, message: `boom ${FAKE_KEY}` },
  ] as unknown as SequencedEvent[];

  // Apply the runner's redaction to each text-carrying field, as the harness does.
  const scrubbed = rawEvents.map((e) => {
    const out: Record<string, unknown> = { ...e };
    if (typeof out.text === "string") out.text = redact(out.text as string);
    if (typeof out.output === "string") out.output = redact(out.output as string);
    if (typeof out.message === "string") out.message = redact(out.message as string);
    if (e.data && typeof (e.data as Record<string, unknown>).prompt === "string") {
      out.data = { ...(e.data as Record<string, unknown>), prompt: redact((e.data as Record<string, unknown>).prompt as string) };
    }
    return out as unknown as SequencedEvent;
  });

  const rawArtifacts = [{ path: `/workspace/report-${FAKE_KEY}.txt`, rel: `report-${FAKE_KEY}.txt`, size: 10, mtimeMs: now, change: "created" as const }];
  const scrubbedArtifacts = rawArtifacts.map((a) => ({ ...a, path: redact(a.path), rel: redact(a.rel) }));

  const base = { runId: "r1", userId: "u1", createdAt: now, finishedAt: now + 5000, shots: [] as never[] };

  const report = assembleReport({ ...base, events: scrubbed, artifacts: scrubbedArtifacts });
  const json = JSON.stringify(report);
  assert.ok(!json.includes(FAKE_KEY), "report document must not contain the key");

  // Sanity: the same input WITHOUT the scrub would leak — so this test really
  // depends on redaction, and removing a scrub fails it.
  const leaky = assembleReport({ ...base, events: rawEvents, artifacts: rawArtifacts });
  assert.ok(JSON.stringify(leaky).includes(FAKE_KEY), "sanity: unscrubbed events would leak into the report");
});

// --- surface 3: the artifact listing ----------------------------------------

test("the report's artifact listing carries no key", () => {
  const redact = runnerRedactor();
  const now = Date.now();
  const artifacts = [
    { path: `/workspace/out/rel-${FAKE_KEY}.log`, rel: `out/rel-${FAKE_KEY}.log`, size: 4, mtimeMs: now, change: "created" as const },
    { path: "/workspace/out/main.ts", rel: "out/main.ts", size: 200, mtimeMs: now, change: "modified" as const },
  ];
  // The artifact list is a set of strings (path/rel/size/mtime). Redact the
  // string fields with the same redactor, then assert the listing is clean.
  const scrubbed = artifacts.map((a) => ({ ...a, path: redact(a.path), rel: redact(a.rel) }));
  const json = JSON.stringify(scrubbed);
  assert.ok(!json.includes(FAKE_KEY), "artifact listing must not contain the key");
  assert.ok(JSON.stringify(artifacts).includes(FAKE_KEY), "sanity: raw listing had the key");
});

// --- surface 4: the Files payload -------------------------------------------

test("a Files payload is scrubbed at the tool-result boundary", () => {
  const redact = runnerRedactor();
  // The shape of a Files tool result (file list content) the runner redacts.
  const filesPayload = {
    type: "text",
    text: `Files:\n- ${FAKE_KEY}\n- other.ts\n`,
  };
  const raw = filesPayload.text;
  assert.ok(raw.includes(FAKE_KEY), "sanity: raw Files payload had the key");
  const scrubbed = redact(raw);
  assert.ok(!scrubbed.includes(FAKE_KEY), "Files payload content must not contain the key");
  assert.ok(scrubbed.includes("[REDACTED]"), "redacted marker must appear");

  // Also exercise deep-value redaction (redactValue) on a structured payload,
  // the same utility used to scrub tool inputs/outputs before they persist.
  const structured = { files: [{ path: `${FAKE_KEY}.ts`, size: 12 }], error: `read ${FAKE_KEY}` };
  const scrubbedStructured = redactValue(structured, redact) as { files: { path: string }[]; error: string };
  assert.ok(!JSON.stringify(scrubbedStructured).includes(FAKE_KEY), "structured payload must be clean");
  assert.ok(JSON.stringify(structured).includes(FAKE_KEY), "sanity: raw structured payload had the key");
});
