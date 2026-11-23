/**
 * End-to-end tests for the embedded Python BYOC worker in the computer-node
 * installer. Tests spawn the worker against a fake node control server and a
 * fake `claude`, and prove the three daemon-level fixes:
 *
 *   1. stream-json events are buffered and flushed as batches (not one
 *      synchronous HTTP POST per line);
 *   2. an HTTP 401 (revoked computer) exits the daemon instead of looping
 *      forever;
 *   3. SIGTERM terminates the claude child instead of orphaning it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { NextRequest } from "next/server";
import { GET } from "./route";

const REAL_PYTHON = spawnSync("which", ["python3"], { encoding: "utf8" }).stdout?.trim() ?? "";
const HAS_PYTHON = REAL_PYTHON.length > 0;

/** Extract the embedded Python worker from the linux installer script. */
async function workerSource(): Promise<string> {
  const res = await GET(new NextRequest("http://localhost/api/computers/node/install?os=linux"));
  const script = await res.text();
  const marker = "exec python3 - \"$OS\" \"$ARCH\" \"$MODE\" <<'PY'\n";
  const start = script.indexOf(marker);
  assert.ok(start >= 0, "worker heredoc marker not found in the install script");
  const bodyStart = start + marker.length;
  const end = script.indexOf("\nPY\n", bodyStart);
  assert.ok(end > bodyStart, "embedded Python worker not found in the install script");
  return script.slice(bodyStart, end);
}

const FAKE_SERVER = String.raw`
import json, os, sys, http.server, socketserver

PATH = sys.argv[1]
PORT = int(sys.argv[2])
with open(os.path.join(PATH, "behavior.json")) as f:
    BEHAVIOR = json.load(f)

LOG = os.path.join(PATH, "requests.jsonl")
state = {"claim": 0}

def record(payload):
    with open(LOG, "a") as f:
        f.write(json.dumps(payload) + "\n")

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-length", str(len(body)))
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("content-length", "0") or 0)
        raw = self.rfile.read(length).decode() if length else ""
        try:
            data = json.loads(raw)
        except Exception:
            data = None
        action = data.get("action") if isinstance(data, dict) else None
        record({"action": action, "body": data})
        if BEHAVIOR.get("return401"):
            self._send({"error": "revoked"}, 401)
            return
        if action == "claim":
            state["claim"] += 1
            if BEHAVIOR.get("claimOnce", True) and state["claim"] == 1:
                self._send({"job": {"runId": "run_test_1", "prompt": "run the fake job", "sessionId": None}})
            else:
                self._send({"job": None})
        elif action == "event":
            self._send({"ok": True})
        elif action == "events":
            entries = data.get("events") if isinstance(data, dict) else []
            self._send({"ok": True, "accepted": len(entries), "rejected": 0})
        elif action == "heartbeat":
            self._send({"ok": True, "computer": {"id": "cmp_test"}})
        elif action == "complete":
            if BEHAVIOR.get("failCompleteCount", 0) > 0:
                BEHAVIOR["failCompleteCount"] -= 1
                self._send({"error": "temporary network error"}, 500)
            else:
                self._send({"ok": True})
        else:
            self._send({"error": "unknown action"}, 400)

with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler) as httpd:
    httpd.serve_forever()
`;

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarm-worker-"));
}

function readRequests(dir: string): Array<{ action: string | null; body: any }> {
  const log = path.join(dir, "requests.jsonl");
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function freePort(): number {
  return 20000 + Math.floor(Math.random() * 20000);
}

function startFakeServer(dir: string, behavior: Record<string, unknown>): { port: number; stop: () => void } {
  fs.writeFileSync(path.join(dir, "behavior.json"), JSON.stringify(behavior));
  fs.writeFileSync(path.join(dir, "fake_server.py"), FAKE_SERVER);
  const port = freePort();
  const proc = spawn(REAL_PYTHON, [path.join(dir, "fake_server.py"), dir, String(port)], { stdio: "ignore" });
  return {
    port,
    stop: () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    },
  };
}

async function waitForServer(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/computers/node`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "heartbeat" }),
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`fake node server on :${port} did not come up`);
}

function writeFakeClaude(dir: string, body: string): void {
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "claude"), body, { mode: 0o755 });
}

/** The worker reads its credentials from ~/.swarmagents/computer.json (never argv). */
function writeWorkerConfig(dir: string, port: number): void {
  const configDir = path.join(dir, ".swarmagents");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "computer.json"),
    JSON.stringify({
      computerId: "cmp_test",
      nodeToken: "ab".repeat(32),
      server: `http://127.0.0.1:${port}`,
    }),
  );
}

/** Spawn the worker and wait until `condition(requests)` holds or the timeout hits. */
async function spawnWorkerUntil(
  dir: string,
  port: number,
  condition: (requests: Array<{ action: string | null; body: any }>) => boolean,
  timeoutMs = 30_000,
): Promise<{ worker: ReturnType<typeof spawn>; requests: Array<{ action: string | null; body: any }> }> {
  const workerPath = path.join(dir, "worker.py");
  fs.writeFileSync(workerPath, await workerSource());
  writeWorkerConfig(dir, port);
  const worker = spawn(
    REAL_PYTHON,
    [workerPath, "linux", "x86_64", "host"],
    { env: { ...process.env, HOME: dir, PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}` }, stdio: "ignore" },
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const requests = readRequests(dir);
    if (condition(requests)) return { worker, requests };
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  worker.kill("SIGKILL");
  throw new Error(`condition not met within ${timeoutMs}ms; saw requests: ${JSON.stringify(readRequests(dir))}`);
}

test("verbose tool runs flush events as batches, not one blocking POST per line", { skip: !HAS_PYTHON }, async () => {
  const dir = tmp();
  const server = startFakeServer(dir, { claimOnce: true });
  try {
    await waitForServer(server.port);
    const claude =
      "#!/bin/sh\n" +
      "python3 - <<'FAKE'\n" +
      "import json\n" +
      'print(json.dumps({"type":"system","subtype":"init","session_id":"sess_fake","model":"claude-sonnet-5-5"}), flush=True)\n' +
      'for i in range(30):\n' +
      '    print(json.dumps({"type":"assistant","message":{"role":"assistant","id":"m%d" % i,"model":"claude-sonnet-5-5","content":[{"type":"text","text":"token %d" % i}]}}), flush=True)\n' +
      'print(json.dumps({"type":"result","subtype":"success","session_id":"sess_fake","total_cost_usd":0.01,"duration_ms":100,"num_turns":1}), flush=True)\n' +
      "FAKE\n";
    writeFakeClaude(dir, claude);
    const { worker } = await spawnWorkerUntil(dir, server.port, (requests) =>
      requests.some((req) => req.action === "complete"),
    );
    worker.kill("SIGKILL");
    const requests = readRequests(dir);
    const eventRequests = requests.filter((req) => req.action === "event" || req.action === "events");
    const totalEvents = eventRequests.reduce((sum, req) => {
      if (req.action === "event") return sum + 1;
      return sum + (Array.isArray(req.body?.events) ? req.body.events.length : 0);
    }, 0);
    assert.ok(totalEvents >= 30, `expected at least 30 events to arrive, got ${totalEvents}`);
    assert.ok(eventRequests.length <= 6, `expected batching to cut event POSTs, got ${eventRequests.length}`);
    assert.ok(requests.some((req) => req.action === "complete"), "the run must complete");
  } finally {
    server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the worker refuses to start without its config file", { skip: !HAS_PYTHON }, async () => {
  const dir = tmp();
  try {
    const workerPath = path.join(dir, "worker.py");
    fs.writeFileSync(workerPath, await workerSource());
    // No ~/.swarmagents/computer.json under this HOME: the worker must fail
    // closed instead of running with empty credentials.
    const result = spawnSync(
      REAL_PYTHON,
      [workerPath, "linux", "x86_64", "host"],
      { env: { ...process.env, HOME: dir }, encoding: "utf8", timeout: 15_000 },
    );
    assert.notEqual(result.status, 0, "the worker must not start without its config");
    assert.match(String(result.stderr), /computer config missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a revoked node (HTTP 401) exits the daemon instead of looping forever", { skip: !HAS_PYTHON }, async () => {
  const dir = tmp();
  const server = startFakeServer(dir, { return401: true });
  try {
    await waitForServer(server.port);
    const workerPath = path.join(dir, "worker.py");
    fs.writeFileSync(workerPath, await workerSource());
    writeWorkerConfig(dir, server.port);
    const started = Date.now();
    const result = spawnSync(
      REAL_PYTHON,
      [workerPath, "linux", "x86_64", "host"],
      { env: { ...process.env, HOME: dir }, encoding: "utf8", timeout: 15_000 },
    );
    assert.ok(!result.error, `worker must exit on its own, got: ${result.error}`);
    assert.ok(Date.now() - started < 15_000, "the worker survived until the test timeout instead of exiting on 401");
    assert.equal(result.status, 0, `worker exit code ${result.status}`);
  } finally {
    server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGTERM terminates the claude child instead of orphaning it", { skip: !HAS_PYTHON }, async () => {
  const dir = tmp();
  const server = startFakeServer(dir, { claimOnce: true });
  const pidFile = path.join(dir, "claude.pid");
  try {
    await waitForServer(server.port);
    const claude =
      "#!/bin/sh\n" +
      `echo $$ > "${pidFile}"\n` +
      "exec python3 -c 'import time; time.sleep(3600)'\n";
    writeFakeClaude(dir, claude);
    const { worker } = await spawnWorkerUntil(
      dir,
      server.port,
      () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim().length > 0,
      15_000,
    );
    worker.kill("SIGTERM");
    const claudePid = Number((fs.readFileSync(pidFile, "utf8") || "").trim());
    const deadline = Date.now() + 10_000;
    let claudeGone = false;
    while (Date.now() < deadline) {
      try {
        process.kill(claudePid, 0);
      } catch {
        claudeGone = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(claudeGone, "the claude child must be terminated with the worker");
  } finally {
    server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("complete() retries on transient 500 error and eventually succeeds", { skip: !HAS_PYTHON }, async () => {
  const dir = tmp();
  // Fail the first complete() attempt with 500, succeeding on the second
  const server = startFakeServer(dir, { claimOnce: true, failCompleteCount: 1 });
  try {
    await waitForServer(server.port);
    const claude =
      "#!/bin/sh\n" +
      "python3 - <<'FAKE'\n" +
      "import json\n" +
      'print(json.dumps({"type":"system","subtype":"init","session_id":"sess_fake","model":"claude-sonnet-5-5"}), flush=True)\n' +
      'print(json.dumps({"type":"result","subtype":"success","session_id":"sess_fake","total_cost_usd":0.01,"duration_ms":100,"num_turns":1}), flush=True)\n' +
      "FAKE\n";
    writeFakeClaude(dir, claude);
    const { worker } = await spawnWorkerUntil(
      dir,
      server.port,
      (requests) => requests.filter((r) => r.action === "complete").length >= 2,
      15_000,
    );
    worker.kill("SIGKILL");
    const requests = readRequests(dir);
    const completeRequests = requests.filter((r) => r.action === "complete");
    assert.ok(completeRequests.length >= 2, `expected at least 2 complete attempts, got ${completeRequests.length}`);
  } finally {
    server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
