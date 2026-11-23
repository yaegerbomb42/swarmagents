/**
 * F16 receipt wiring tests (Worker 3):
 *   - `hashArtifacts` round-trips content hashes and records a gone or
 *     over-cap file explicitly as missing (never silently omitted).
 *   - The reporter attaches a receipt at finalize time: signed when the
 *     server secret is set, unsigned (`signature: null` + `signingError`)
 *     when it is not — and the run/report still succeed either way.
 *   - Command-log secrets never reach the stored receipt (redaction).
 *   - The receipt routes: GET export + POST verify (pass/fail, exported
 *     bundle in the body), owner-only auth (401/404).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { TelemetryBus, type SequencedEvent } from "../telemetry/bus";
import { configureRunsDir } from "../telemetry/paths";
import { WORKSPACE_ROOT } from "../vm/files";
import { FakeVmDriver } from "../vm/fake-driver";
import { VmManager } from "../vm/manager";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";
import { sha256Hex } from "../library/proof";
import { assembleReport, hashArtifacts, readRunReport, writeRunReport } from "./run-report";
import { buildRunReceipt, RunReporter } from "./run-reporter";
import { verifyReceipt } from "./run-receipt";
import { GET as GET_RECEIPT } from "../../app/api/runtime/runs/[id]/report/receipt/route";
import { POST as POST_VERIFY } from "../../app/api/runtime/runs/[id]/report/receipt/verify/route";
import type { ReportArtifact } from "./run-report-types";
import type { BrowserControl } from "../browser/manager";

const SECRET = "test-receipt-secret-0123456789abcdef";
const ARTIFACT_CONTENT = "hello receipt";

/** Fake driver with an overridable /workspace file listing for `find`. */
class FakeFindDriver extends FakeVmDriver {
  entries = new Map<string, { size: number; mtimeMs: number }>();

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] === "find") {
      const out: string[] = [];
      for (const [file, entry] of this.entries) {
        out.push(file, String(entry.size), (entry.mtimeMs / 1000).toFixed(3));
      }
      if (out.length > 0) opts?.onStdout?.(`${out.join("\0")}\0`);
      return { exitCode: 0 };
    }
    return super.exec(handle, cmd, opts);
  }
}

class StubBrowser implements BrowserControl {
  async navigate(): Promise<never> {
    throw new Error("not used");
  }
  async screenshot(): Promise<never> {
    throw new Error("not used");
  }
  async act(): Promise<never> {
    throw new Error("not used");
  }
  async evaluate(): Promise<never> {
    throw new Error("not used");
  }
  async getDiagnostics(): Promise<never> {
    throw new Error("not used");
  }
  async getFrame(): Promise<{ frameId: number; jpeg: Buffer; width: number; height: number; capturedAt: number }> {
    return { frameId: 1, jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), width: 2, height: 2, capturedAt: Date.now() };
  }
  async close(): Promise<void> {}
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarm-receipt-wiring-"));
}

async function waitFor<T>(fn: () => T | null, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Run `fn` with SWARM_SESSION_SECRET set (or unset), restoring after. */
async function withSecret<T>(secret: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.SWARM_SESSION_SECRET;
  if (secret === undefined) delete process.env.SWARM_SESSION_SECRET;
  else process.env.SWARM_SESSION_SECRET = secret;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.SWARM_SESSION_SECRET;
    else process.env.SWARM_SESSION_SECRET = prev;
  }
}

function artifact(rel: string, size: number): ReportArtifact {
  return {
    path: `${WORKSPACE_ROOT}/${rel}`,
    rel,
    size,
    mtimeMs: 2_000,
    change: "created",
  };
}

// --- hashArtifacts ----------------------------------------------------------

test("hashArtifacts records sha256 + present for readable files", async () => {
  const driver = new FakeVmDriver();
  const vm = new VmManager({ customDriver: driver });
  const handle = await driver.ensure("alice");
  await driver.writeFile(handle, "/workspace/a.txt", ARTIFACT_CONTENT);
  const hashed = await hashArtifacts(vm, "alice", [artifact("a.txt", ARTIFACT_CONTENT.length)]);
  assert.equal(hashed[0]?.sha256, sha256Hex(Buffer.from(ARTIFACT_CONTENT, "utf8")));
  assert.equal(hashed[0]?.status, "present");
});

test("hashArtifacts records a file gone between listing and read as missing", async () => {
  const driver = new FakeVmDriver();
  const vm = new VmManager({ customDriver: driver });
  // Listed as an artifact, but never written to the VM: gone at hash time.
  const hashed = await hashArtifacts(vm, "alice", [artifact("ghost.txt", 4)]);
  assert.equal(hashed[0]?.sha256, null);
  assert.equal(hashed[0]?.status, "missing");
});

test("hashArtifacts records an over-cap file as missing without throwing", async () => {
  const driver = new FakeVmDriver();
  const vm = new VmManager({ customDriver: driver });
  const handle = await driver.ensure("alice");
  await driver.writeFile(handle, "/workspace/big.txt", "0123456789");
  // Size (10) exceeds the 4-byte cap passed here: skipped, not crashed.
  const hashed = await hashArtifacts(vm, "alice", [artifact("big.txt", 10)], 4);
  assert.equal(hashed[0]?.sha256, null);
  assert.equal(hashed[0]?.status, "missing");
});

// --- reporter finalize attaches a receipt ----------------------------------

async function runToReport(opts: {
  runsDir: string;
  driver: FakeFindDriver;
  runId: string;
  userId: string;
  publish: (bus: TelemetryBus, runId: string) => void;
}): Promise<ReturnType<typeof readRunReport>> {
  const bus = new TelemetryBus({ persist: true, runsDir: () => opts.runsDir });
  const vm = new VmManager({ customDriver: opts.driver });
  const reporter = new RunReporter({
    vm,
    bus,
    browser: new StubBrowser(),
    runsDir: () => opts.runsDir,
  });
  reporter.attach(opts.runId, opts.userId);
  bus.publish(opts.runId, {
    type: "run.created",
    data: { prompt: "make a file", userId: opts.userId },
  });
  bus.publish(opts.runId, { type: "vm.ready", data: { ms: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  opts.publish(bus, opts.runId);
  bus.publish(opts.runId, { type: "run.finished", exitCode: 0, sessionId: "s1" } as never);
  return waitFor(() => readRunReport(opts.runId, opts.runsDir));
}

test("finalize attaches a signed receipt with hashed artifacts", async () => {
  await withSecret(SECRET, async () => {
    const runsDir = tmpDir();
    try {
      const driver = new FakeFindDriver();
      const handle = await driver.ensure("alice");
      await driver.writeFile(handle, "/workspace/new.txt", ARTIFACT_CONTENT);
      const report = await runToReport({
        runsDir,
        driver,
        runId: "run_receipt",
        userId: "alice",
        publish: (bus, runId) => {
          driver.entries.set("/workspace/new.txt", { size: ARTIFACT_CONTENT.length, mtimeMs: 2_000 });
          bus.publish(runId, {
            type: "approval.required",
            approval: { id: "ap1", riskLevel: "ask", tool: "Bash" },
          } as never);
          bus.publish(runId, { type: "approval.resolved", id: "ap1", verdict: "approved" } as never);
          bus.publish(runId, {
            type: "shell.cmd",
            data: { command: "echo hi" },
          } as never);
        },
      });
      assert.ok(report);
      assert.equal(report!.artifacts.length, 1);
      assert.equal(report!.artifacts[0]?.sha256, sha256Hex(Buffer.from(ARTIFACT_CONTENT, "utf8")));
      assert.equal(report!.artifacts[0]?.status, "present");
      const receipt = report!.receipt;
      assert.ok(receipt, "receipt attached");
      assert.equal(typeof receipt!.signature, "string");
      assert.equal(receipt!.signingError, undefined);
      assert.deepEqual(verifyReceipt(receipt), { ok: true });
      const kinds = receipt!.links.map((link) => link.kind);
      assert.equal(kinds[0], "prompt");
      assert.ok(kinds.includes("approval"));
      assert.ok(kinds.includes("command"));
      assert.equal(kinds[kinds.length - 1], "artifact");
      const artifactEntry = receipt!.links[receipt!.links.length - 1]!.entry as Record<string, unknown>;
      assert.equal(artifactEntry.rel, "new.txt");
      assert.equal(artifactEntry.sha256, sha256Hex(Buffer.from(ARTIFACT_CONTENT, "utf8")));
      assert.equal(artifactEntry.status, "present");
    } finally {
      fs.rmSync(runsDir, { recursive: true, force: true });
    }
  });
});

test("finalize records a deleted artifact as missing inside the receipt", async () => {
  await withSecret(SECRET, async () => {
    const runsDir = tmpDir();
    try {
      const driver = new FakeFindDriver();
      const report = await runToReport({
        runsDir,
        driver,
        runId: "run_receipt_gone",
        userId: "alice",
        publish: () => {
          // Listed at finalize time but never written: gone at hash time.
          driver.entries.set("/workspace/gone.txt", { size: 4, mtimeMs: 2_000 });
        },
      });
      assert.ok(report);
      assert.equal(report!.artifacts[0]?.sha256, null);
      assert.equal(report!.artifacts[0]?.status, "missing");
      const artifactEntry = report!.receipt!.links.find((link) => link.kind === "artifact")!
        .entry as Record<string, unknown>;
      assert.equal(artifactEntry.rel, "gone.txt");
      assert.equal(artifactEntry.sha256, null);
      assert.equal(artifactEntry.status, "missing");
      assert.deepEqual(verifyReceipt(report!.receipt), { ok: true });
    } finally {
      fs.rmSync(runsDir, { recursive: true, force: true });
    }
  });
});

test("finalize stores the receipt unsigned when no secret is set", async () => {
  await withSecret(undefined, async () => {
    const runsDir = tmpDir();
    try {
      const driver = new FakeFindDriver();
      const report = await runToReport({
        runsDir,
        driver,
        runId: "run_receipt_unsigned",
        userId: "alice",
        publish: () => {},
      });
      assert.ok(report, "report still written without a secret");
      assert.ok(report!.receipt, "receipt still attached");
      assert.equal(report!.receipt!.signature, null);
      assert.match(report!.receipt!.signingError ?? "", /SWARM_SESSION_SECRET/);
      // An unsigned receipt never verifies — but as a signature failure,
      // not a chain failure.
      assert.deepEqual(verifyReceipt(report!.receipt), { ok: false, reason: "signature" });
    } finally {
      fs.rmSync(runsDir, { recursive: true, force: true });
    }
  });
});

test("a secret-shaped token in a command log never reaches the receipt", async () => {
  await withSecret(SECRET, async () => {
    const runsDir = tmpDir();
    try {
      const driver = new FakeFindDriver();
      const leaked = "sk-ant-abcdefghij1234567890";
      const report = await runToReport({
        runsDir,
        driver,
        runId: "run_receipt_redact",
        userId: "alice",
        publish: (bus, runId) => {
          bus.publish(runId, {
            type: "shell.cmd",
            data: { command: `curl -H "x-key: ${leaked}" https://example.invalid` },
          } as never);
        },
      });
      assert.ok(report?.receipt);
      assert.ok(!JSON.stringify(report!.receipt).includes(leaked), "secret must not appear in the receipt");
      assert.ok(JSON.stringify(report!.receipt).includes("[REDACTED]"));
      assert.deepEqual(verifyReceipt(report!.receipt), { ok: true });
    } finally {
      fs.rmSync(runsDir, { recursive: true, force: true });
    }
  });
});

// --- receipt routes ----------------------------------------------------------

function request(
  url: string,
  user: string | null = "alice",
  init?: Omit<RequestInit, "signal">,
): NextRequest {
  const headers = new Headers(init?.headers);
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest(`http://localhost${url}`, { ...init, headers });
}

function seedEvents(userId: string): SequencedEvent[] {
  return [
    { type: "run.created", data: { prompt: "make two files", userId }, seq: 1, runId: "run_1", ts: 1_000 },
    { type: "run.started", sessionId: "s1", model: "claude-test", provider: "anthropic", seq: 2, runId: "run_1", ts: 2_000 },
    { type: "assistant.text", text: "all done", seq: 3, runId: "run_1", ts: 3_000 },
    { type: "run.finished", exitCode: 0, sessionId: "s1", costUsd: 0.1, durationMs: 5000, numTurns: 2, seq: 4, runId: "run_1", ts: 6_000 },
  ] as unknown as SequencedEvent[];
}

function seedReportWithReceipt(runsDir: string): void {
  const report = assembleReport({
    runId: "run_1",
    userId: "alice",
    events: seedEvents("alice"),
    createdAt: 1_000,
    finishedAt: 6_000,
    artifacts: [
      {
        path: "/workspace/a.txt",
        rel: "a.txt",
        size: 5,
        mtimeMs: 6_000,
        change: "created",
        sha256: sha256Hex(Buffer.from("hello", "utf8")),
        status: "present",
      },
    ],
    shots: [],
  });
  report.receipt = buildRunReceipt(report, seedEvents("alice"));
  writeRunReport("run_1", report, runsDir);
}

test("GET receipt returns the stored receipt; POST verify passes", async () => {
  await withSecret(SECRET, async () => {
    const runsDir = tmpDir();
    configureRunsDir(runsDir);
    try {
      seedReportWithReceipt(runsDir);
      const res = await GET_RECEIPT(request("/api/runtime/runs/run_1/report/receipt"), {
        params: Promise.resolve({ id: "run_1" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { format: string; links: unknown[] };
      assert.equal(body.format, "swarmagents.receipt/v1");
      assert.ok(Array.isArray(body.links) && body.links.length > 0);

      const verify = await POST_VERIFY(request("/api/runtime/runs/run_1/report/receipt/verify", "alice", { method: "POST" }), {
        params: Promise.resolve({ id: "run_1" }),
      });
      assert.equal(verify.status, 200);
      assert.deepEqual(await verify.json(), { ok: true });
    } finally {
      configureRunsDir(null);
      fs.rmSync(runsDir, { recursive: true, force: true });
    }
  });
});

test("POST verify names the failed link when the stored chain is tampered", async () => {
  await withSecret(SECRET, async () => {
    const runsDir = tmpDir();
    configureRunsDir(runsDir);
    try {
      seedReportWithReceipt(runsDir);
      const report = readRunReport("run_1", runsDir)!;
      // Tamper the prompt entry's hash input without re-signing.
      const promptLink = report.receipt!.links[0]!;
      (promptLink.entry as Record<string, unknown>).sha256 = "0".repeat(64);
      writeRunReport("run_1", report, runsDir);

      const verify = await POST_VERIFY(request("/api/runtime/runs/run_1/report/receipt/verify", "alice", { method: "POST" }), {
        params: Promise.resolve({ id: "run_1" }),
      });
      assert.equal(verify.status, 200);
      assert.deepEqual(await verify.json(), { ok: false, failedLink: 0, reason: "chain" });
    } finally {
      configureRunsDir(null);
      fs.rmSync(runsDir, { recursive: true, force: true });
    }
  });
});

test("POST verify checks an exported bundle supplied in the body", async () => {
  await withSecret(SECRET, async () => {
    const runsDir = tmpDir();
    configureRunsDir(runsDir);
    try {
      seedReportWithReceipt(runsDir);
      const stored = readRunReport("run_1", runsDir)!.receipt!;
      const tampered = JSON.parse(JSON.stringify(stored)) as typeof stored;
      tampered.signature = "0".repeat(64);
      const verify = await POST_VERIFY(
        request("/api/runtime/runs/run_1/report/receipt/verify", "alice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ receipt: tampered }),
        }),
        { params: Promise.resolve({ id: "run_1" }) },
      );
      assert.equal(verify.status, 200);
      assert.deepEqual(await verify.json(), { ok: false, reason: "signature" });
    } finally {
      configureRunsDir(null);
      fs.rmSync(runsDir, { recursive: true, force: true });
    }
  });
});

test("receipt routes are owner-only: 401 without a user, 404 for another owner", async () => {
  await withSecret(SECRET, async () => {
    const runsDir = tmpDir();
    configureRunsDir(runsDir);
    try {
      seedReportWithReceipt(runsDir);
      const ctx = { params: Promise.resolve({ id: "run_1" }) };

      const anon = await GET_RECEIPT(request("/api/runtime/runs/run_1/report/receipt", null), ctx);
      assert.equal(anon.status, 401);
      const anonVerify = await POST_VERIFY(
        request("/api/runtime/runs/run_1/report/receipt/verify", null, { method: "POST" }),
        ctx,
      );
      assert.equal(anonVerify.status, 401);

      const other = await GET_RECEIPT(request("/api/runtime/runs/run_1/report/receipt", "mallory"), ctx);
      assert.equal(other.status, 404);
      const otherVerify = await POST_VERIFY(
        request("/api/runtime/runs/run_1/report/receipt/verify", "mallory", { method: "POST" }),
        ctx,
      );
      assert.equal(otherVerify.status, 404);

      const missing = await GET_RECEIPT(request("/api/runtime/runs/run_nope/report/receipt"), {
        params: Promise.resolve({ id: "run_nope" }),
      });
      assert.equal(missing.status, 404);
    } finally {
      configureRunsDir(null);
      fs.rmSync(runsDir, { recursive: true, force: true });
    }
  });
});

test("GET receipt 404s when the report has no receipt", async () => {
  const runsDir = tmpDir();
  configureRunsDir(runsDir);
  try {
    const report = assembleReport({
      runId: "run_1",
      userId: "alice",
      events: seedEvents("alice"),
      createdAt: 1_000,
      finishedAt: 6_000,
      artifacts: [],
      shots: [],
    });
    writeRunReport("run_1", report, runsDir);
    const res = await GET_RECEIPT(request("/api/runtime/runs/run_1/report/receipt"), {
      params: Promise.resolve({ id: "run_1" }),
    });
    assert.equal(res.status, 404);
  } finally {
    configureRunsDir(null);
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});
