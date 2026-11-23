import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  directModeConfigurationError,
  missingDockerApprovalEnv,
  missingLlmProxyEnv,
  RuntimeManager,
} from "./manager";
import { writeConfiguredProviders } from "../providers/store";
import { TelemetryBus } from "../telemetry/bus";
import { VmManager } from "../vm/manager";

const ENV_KEYS = [
  "SWARM_SERVER_MODE",
  "SWARM_PUBLIC_ORIGIN",
  "SWARM_VM_LLM_BASE_URL",
  "SWARM_VM_APPROVAL_BASE_URL",
  "SWARM_SESSION_SECRET",
  "SWARM_HOME",
] as const;

const U = "local_gateway-env@example.com";

let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-gateway-env-"));
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function withEnv<T>(
  values: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  fn: () => T,
): T {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.SWARM_HOME = tempDir;
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

function seedOpenAiProvider(): void {
  writeConfiguredProviders(U, [
    {
      id: "deepseek",
      kind: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      keys: ["sk-test-gateway-env"],
    },
  ]);
}

function seedAnthropicProvider(): void {
  writeConfiguredProviders(U, [
    { id: "anthropic", kind: "anthropic", keys: ["sk-ant-test-gateway-env"] },
  ]);
}

const dockerVm = () => new VmManager({ driver: "docker" });

test("server mode + OpenAI-style provider + no proxy env rejects run start naming the missing vars", () => {
  withEnv(
    {
      SWARM_SERVER_MODE: "1",
      SWARM_VM_APPROVAL_BASE_URL: "http://172.17.0.1:3777",
      SWARM_SESSION_SECRET: "test-secret",
    },
    () => {
      seedOpenAiProvider();
      const manager = new RuntimeManager({ vm: dockerVm(), bus: new TelemetryBus() });

      const result = manager.start(U, { prompt: "hello" });

      assert.equal(result.accepted, false);
      assert.equal(result.runId, "");
      assert.equal(result.queued, false);
      assert.match(result.error ?? "", /SWARM_VM_LLM_BASE_URL/);
      assert.match(result.error ?? "", /SWARM_PUBLIC_ORIGIN/);
      assert.match(result.error ?? "", /deepseek/);
      assert.deepEqual(result.missingEnv, ["SWARM_VM_LLM_BASE_URL", "SWARM_PUBLIC_ORIGIN"]);
      assert.deepEqual(manager.list(U), []);
    },
  );
});

test("server mode + Anthropic provider + no proxy env is still allowed", () => {
  withEnv(
    {
      SWARM_SERVER_MODE: "1",
      SWARM_VM_APPROVAL_BASE_URL: "http://172.17.0.1:3777",
      SWARM_SESSION_SECRET: "test-secret",
    },
    () => {
      seedAnthropicProvider();
      assert.equal(directModeConfigurationError(dockerVm(), U), null);
    },
  );
});

test("local mode keeps direct provider mode unchanged", () => {
  withEnv({ SWARM_SESSION_SECRET: "test-secret" }, () => {
    seedOpenAiProvider();
    assert.equal(directModeConfigurationError(dockerVm(), U), null);
    assert.deepEqual(missingLlmProxyEnv(), []);
  });
});

test("server mode with a proxy origin configured is allowed for OpenAI-style providers", () => {
  withEnv(
    {
      SWARM_SERVER_MODE: "1",
      SWARM_PUBLIC_ORIGIN: "https://agents.example.com",
      SWARM_SESSION_SECRET: "test-secret",
    },
    () => {
      seedOpenAiProvider();
      assert.equal(directModeConfigurationError(dockerVm(), U), null);
      assert.deepEqual(missingLlmProxyEnv(), []);
    },
  );

  withEnv(
    {
      SWARM_SERVER_MODE: "1",
      SWARM_VM_LLM_BASE_URL: "http://172.17.0.1:3777",
      SWARM_SESSION_SECRET: "test-secret",
    },
    () => {
      seedOpenAiProvider();
      assert.equal(directModeConfigurationError(dockerVm(), U), null);
      assert.deepEqual(missingLlmProxyEnv(), []);
    },
  );
});

test("the direct-mode guard does not gate non-Docker drivers", () => {
  withEnv({ SWARM_SERVER_MODE: "1", SWARM_SESSION_SECRET: "test-secret" }, () => {
    seedOpenAiProvider();
    assert.equal(
      directModeConfigurationError(new VmManager({ driver: "fake" }), U),
      null,
    );
  });
});

test("no usable providers does not invent a direct-mode error", () => {
  withEnv({ SWARM_SERVER_MODE: "1", SWARM_SESSION_SECRET: "test-secret" }, () => {
    assert.equal(directModeConfigurationError(dockerVm(), U), null);
  });
});

test("missingDockerApprovalEnv names SWARM_PUBLIC_ORIGIN in server mode", () => {
  withEnv({ SWARM_SERVER_MODE: "1" }, () => {
    assert.deepEqual(missingDockerApprovalEnv(dockerVm()), [
      "SWARM_VM_APPROVAL_BASE_URL",
      "SWARM_PUBLIC_ORIGIN",
      "SWARM_SESSION_SECRET",
    ]);
  });

  withEnv({}, () => {
    assert.deepEqual(missingDockerApprovalEnv(dockerVm()), [
      "SWARM_VM_APPROVAL_BASE_URL",
      "SWARM_SESSION_SECRET",
    ]);
  });

  withEnv(
    {
      SWARM_SERVER_MODE: "1",
      SWARM_PUBLIC_ORIGIN: "https://agents.example.com",
      SWARM_SESSION_SECRET: "test-secret",
    },
    () => {
      assert.deepEqual(missingDockerApprovalEnv(dockerVm()), []);
    },
  );

  withEnv({}, () => {
    assert.deepEqual(missingDockerApprovalEnv(new VmManager({ driver: "fake" })), []);
  });
});

test("run start refused by the approval gate carries missingEnv (FIX-11)", () => {
  withEnv({ SWARM_SERVER_MODE: "1" }, () => {
    const manager = new RuntimeManager({ vm: dockerVm(), bus: new TelemetryBus() });

    const result = manager.start(U, { prompt: "hello" });

    assert.equal(result.accepted, false);
    assert.match(result.error ?? "", /SWARM_PUBLIC_ORIGIN/);
    assert.deepEqual(result.missingEnv, [
      "SWARM_VM_APPROVAL_BASE_URL",
      "SWARM_PUBLIC_ORIGIN",
      "SWARM_SESSION_SECRET",
    ]);
    assert.deepEqual(manager.list(U), []);
  });
});
