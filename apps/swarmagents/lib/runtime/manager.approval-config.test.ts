import test from "node:test";
import assert from "node:assert/strict";
import {
  localDockerApprovalConfigurationError,
  RuntimeManager,
} from "./manager";
import { TelemetryBus } from "../telemetry/bus";
import { VmManager } from "../vm/manager";

const ENV_KEYS = [
  "SWARM_SERVER_MODE",
  "SWARM_PUBLIC_ORIGIN",
  "SWARM_VM_LLM_BASE_URL",
  "SWARM_VM_APPROVAL_BASE_URL",
  "SWARM_SESSION_SECRET",
] as const;

function withApprovalEnv<T>(
  values: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  fn: () => T,
): T {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("local Docker agent startup is refused before a run when approval config is absent", () => {
  withApprovalEnv({}, () => {
    const vm = new VmManager({ driver: "docker" });
    const manager = new RuntimeManager({ vm, bus: new TelemetryBus() });

    const result = manager.start("u-approval-config-missing", { prompt: "hello" });

    assert.equal(result.accepted, false);
    assert.equal(result.runId, "");
    assert.equal(result.queued, false);
    assert.match(result.error ?? "", /startup configuration error/i);
    assert.match(result.error ?? "", /SWARM_VM_APPROVAL_BASE_URL/);
    assert.match(result.error ?? "", /SWARM_SESSION_SECRET/);
    assert.match(result.error ?? "", /PreToolUse/);
    assert.match(result.error ?? "", /host\.docker\.internal/);
    assert.match(result.error ?? "", /Linux.*bridge gateway/);
    assert.deepEqual(manager.list("u-approval-config-missing"), []);
  });
});

test("local Docker approval validation requires a token-signing secret", () => {
  withApprovalEnv(
    { SWARM_VM_APPROVAL_BASE_URL: "http://host.docker.internal:3777" },
    () => {
      const error = localDockerApprovalConfigurationError(new VmManager({ driver: "docker" }));
      assert.match(error ?? "", /^Docker VM startup configuration error: SWARM_SESSION_SECRET must be configured\./);
    },
  );
});

test("local Docker approval validation accepts explicit and LLM-fallback VM origins", () => {
  withApprovalEnv(
    {
      SWARM_VM_APPROVAL_BASE_URL: "http://host.docker.internal:3777",
      SWARM_SESSION_SECRET: "test-secret",
    },
    () => {
      assert.equal(localDockerApprovalConfigurationError(new VmManager({ driver: "docker" })), null);
    },
  );

  withApprovalEnv(
    {
      SWARM_VM_LLM_BASE_URL: "http://172.17.0.1:3777",
      SWARM_SESSION_SECRET: "test-secret",
    },
    () => {
      assert.equal(localDockerApprovalConfigurationError(new VmManager({ driver: "docker" })), null);
    },
  );
});

test("server-mode Docker also rejects a missing public approval origin", () => {
  withApprovalEnv({ SWARM_SERVER_MODE: "1", SWARM_SESSION_SECRET: "test-secret" }, () => {
    const error = localDockerApprovalConfigurationError(new VmManager({ driver: "docker" }));
    assert.match(error ?? "", /SWARM_VM_APPROVAL_BASE_URL/);
  });

  withApprovalEnv({
    SWARM_SERVER_MODE: "1",
    SWARM_PUBLIC_ORIGIN: "https://agents.example.com",
    SWARM_SESSION_SECRET: "test-secret",
  }, () => {
    assert.equal(localDockerApprovalConfigurationError(new VmManager({ driver: "docker" })), null);
  });
});

test("approval startup validation does not reject the local fake driver", () => {
  withApprovalEnv({}, () => {
    assert.equal(localDockerApprovalConfigurationError(new VmManager({ driver: "fake" })), null);
  });
});
