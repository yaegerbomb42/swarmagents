/**
 * FIX-10/FIX-11 route tests: run-start refusals name the missing env vars.
 *
 * Split out of the bundle's route.test.ts (which predates main's e2e
 * route.test.ts at the same path) so both suites coexist; import paths
 * converted to this directory's relative style.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import { writeConfiguredProviders } from "../../../../lib/providers/store";
import { RuntimeManager, setRuntimeManagerForTesting } from "../../../../lib/runtime/manager";
import { TelemetryBus } from "../../../../lib/telemetry/bus";
import { VmManager } from "../../../../lib/vm/manager";
import { POST } from "./route";

const URL = "http://localhost/api/runtime/tasks";
const ALICE = "local_alice@example.test";

const ENV_KEYS = [
  "SWARM_SERVER_MODE",
  "SWARM_PUBLIC_ORIGIN",
  "SWARM_VM_LLM_BASE_URL",
  "SWARM_VM_APPROVAL_BASE_URL",
  "SWARM_SESSION_SECRET",
  "SWARM_HOME",
] as const;

let tempDir: string;
let cleanup: () => void;

test.beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-tasks-route-"));
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.SWARM_HOME = tempDir;
  setRuntimeManagerForTesting(
    new RuntimeManager({ vm: new VmManager({ driver: "docker" }), bus: new TelemetryBus() }),
  );
  cleanup = () => {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setRuntimeManagerForTesting(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
  };
});
test.afterEach(() => cleanup());

function post(body: unknown): Promise<Response> {
  return POST(
    new NextRequest(URL, {
      method: "POST",
      headers: { "content-type": "application/json", [USER_HEADER]: ALICE },
      body: JSON.stringify(body),
    }),
  );
}

type ErrorBody = { error?: string; missingEnv?: string[] };

test("run start with SWARM_PUBLIC_ORIGIN unset names the missing vars in the error body", async () => {
  process.env.SWARM_SERVER_MODE = "1";

  const response = await post({ prompt: "hello" });

  assert.equal(response.status, 400);
  const body = (await response.json()) as ErrorBody;
  assert.match(body.error ?? "", /SWARM_PUBLIC_ORIGIN/);
  assert.ok(body.missingEnv?.includes("SWARM_PUBLIC_ORIGIN"), JSON.stringify(body));
  assert.ok(body.missingEnv?.includes("SWARM_VM_APPROVAL_BASE_URL"), JSON.stringify(body));
  assert.ok(body.missingEnv?.includes("SWARM_SESSION_SECRET"), JSON.stringify(body));
});

test("server-mode direct mode for an OpenAI-style provider is refused with missingEnv", async () => {
  process.env.SWARM_SERVER_MODE = "1";
  process.env.SWARM_SESSION_SECRET = "test-secret";
  process.env.SWARM_VM_APPROVAL_BASE_URL = "http://172.17.0.1:3777";
  writeConfiguredProviders(ALICE, [
    {
      id: "deepseek",
      kind: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      keys: ["sk-test-tasks-route"],
    },
  ]);

  const response = await post({ prompt: "hello" });

  assert.equal(response.status, 400);
  const body = (await response.json()) as ErrorBody;
  assert.match(body.error ?? "", /SWARM_VM_LLM_BASE_URL/);
  assert.match(body.error ?? "", /SWARM_PUBLIC_ORIGIN/);
  assert.deepEqual(body.missingEnv, ["SWARM_VM_LLM_BASE_URL", "SWARM_PUBLIC_ORIGIN"]);
});
