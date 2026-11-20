import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VM_CPUS,
  DEFAULT_VM_MEMORY,
  DEFAULT_VM_PIDS,
  VmLimitError,
  resolveVmLimits,
  validateCpuLimit,
  validateMemoryLimit,
  validatePidsLimit,
} from "./limits.js";
import {
  DockerVmDriver,
  VM_CAPABILITIES,
  VmRuntimeError,
  buildRunArgs,
  buildUpdateArgs,
} from "./docker-driver.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("validateMemoryLimit accepts docker memory sizes", () => {
  assert.equal(validateMemoryLimit("2g"), "2g");
  assert.equal(validateMemoryLimit("512m"), "512m");
  assert.equal(validateMemoryLimit("1k"), "1k");
  assert.equal(validateMemoryLimit("1.5g"), "1.5g");
  assert.equal(validateMemoryLimit("2G"), "2g");
  assert.equal(validateMemoryLimit("1073741824"), "1073741824");
});

test("validateMemoryLimit rejects anything docker would not understand", () => {
  assert.throws(() => validateMemoryLimit("abc"), VmLimitError);
  assert.throws(() => validateMemoryLimit("2x"), VmLimitError);
  assert.throws(() => validateMemoryLimit("2 gig"), VmLimitError);
  assert.throws(() => validateMemoryLimit(""), VmLimitError);
  assert.throws(() => validateMemoryLimit("0g"), /greater than 0/);
  assert.throws(() => validateMemoryLimit("-1g"), VmLimitError);
});

test("validateCpuLimit accepts positive core counts", () => {
  assert.equal(validateCpuLimit("2"), "2");
  assert.equal(validateCpuLimit("2.0"), "2.0");
  assert.equal(validateCpuLimit("0.5"), "0.5");
});

test("validateCpuLimit rejects zero, negatives and junk", () => {
  assert.throws(() => validateCpuLimit("0"), /greater than 0/);
  assert.throws(() => validateCpuLimit("-1"), VmLimitError);
  assert.throws(() => validateCpuLimit("two"), VmLimitError);
  assert.throws(() => validateCpuLimit("2 cores"), VmLimitError);
  assert.throws(() => validateCpuLimit(""), VmLimitError);
});

test("validatePidsLimit accepts positive integers only", () => {
  assert.equal(validatePidsLimit("512"), "512");
  assert.equal(validatePidsLimit("1"), "1");
});

test("validatePidsLimit rejects unlimited or malformed values", () => {
  assert.throws(() => validatePidsLimit("0"), /at least 1/);
  assert.throws(() => validatePidsLimit("-1"), VmLimitError);
  assert.throws(() => validatePidsLimit("1.5"), VmLimitError);
  assert.throws(() => validatePidsLimit("many"), VmLimitError);
  assert.throws(() => validatePidsLimit(""), VmLimitError);
});

// ---------------------------------------------------------------------------
// Resolution from the environment
// ---------------------------------------------------------------------------

test("resolveVmLimits falls back to 2g / 2 / 512", () => {
  assert.deepEqual(resolveVmLimits({}), {
    memory: DEFAULT_VM_MEMORY,
    cpus: DEFAULT_VM_CPUS,
    pids: DEFAULT_VM_PIDS,
  });
  assert.equal(DEFAULT_VM_MEMORY, "2g");
  assert.equal(DEFAULT_VM_CPUS, "2");
  assert.equal(DEFAULT_VM_PIDS, "512");
});

test("resolveVmLimits reads SWARM_VM_MEMORY / SWARM_VM_CPUS / SWARM_VM_PIDS", () => {
  assert.deepEqual(
    resolveVmLimits({
      SWARM_VM_MEMORY: "512m",
      SWARM_VM_CPUS: "1.5",
      SWARM_VM_PIDS: "128",
    }),
    { memory: "512m", cpus: "1.5", pids: "128" },
  );
});

test("resolveVmLimits honors the legacy SWARM_VM_PIDS_LIMIT alias", () => {
  assert.equal(resolveVmLimits({ SWARM_VM_PIDS_LIMIT: "64" }).pids, "64");
  // The current name wins when both are set.
  assert.equal(
    resolveVmLimits({ SWARM_VM_PIDS: "128", SWARM_VM_PIDS_LIMIT: "64" }).pids,
    "128",
  );
});

test("resolveVmLimits treats blank env values as unset", () => {
  assert.deepEqual(resolveVmLimits({ SWARM_VM_MEMORY: "  ", SWARM_VM_PIDS: "" }), {
    memory: DEFAULT_VM_MEMORY,
    cpus: DEFAULT_VM_CPUS,
    pids: DEFAULT_VM_PIDS,
  });
});

test("resolveVmLimits lets explicit overrides win over the environment", () => {
  assert.deepEqual(
    resolveVmLimits({ SWARM_VM_MEMORY: "512m", SWARM_VM_PIDS: "128" }, { memory: "4g", pids: "64" }),
    { memory: "4g", cpus: DEFAULT_VM_CPUS, pids: "64" },
  );
});

test("resolveVmLimits names the offending env var when a value is invalid", () => {
  assert.throws(
    () => resolveVmLimits({ SWARM_VM_MEMORY: "huge" }),
    /Invalid SWARM_VM_MEMORY/,
  );
  assert.throws(() => resolveVmLimits({ SWARM_VM_CPUS: "many" }), /Invalid SWARM_VM_CPUS/);
  assert.throws(() => resolveVmLimits({ SWARM_VM_PIDS: "0" }), /Invalid SWARM_VM_PIDS/);
  assert.throws(
    () => resolveVmLimits({ SWARM_VM_PIDS_LIMIT: "-1" }),
    /Invalid SWARM_VM_PIDS_LIMIT/,
  );
});

// ---------------------------------------------------------------------------
// docker argv
// ---------------------------------------------------------------------------

test("buildRunArgs passes the memory, cpu and pid ceilings to docker", () => {
  const argv = buildRunArgs({
    containerName: "swarm-vm-a",
    volume: "swarm-vm-a-workspace",
    image: "node:22-bookworm-slim",
    memory: "2g",
    cpus: "2",
    pidsLimit: "512",
  });

  assert.equal(argv[argv.indexOf("--memory") + 1], "2g");
  assert.equal(argv[argv.indexOf("--cpus") + 1], "2");
  assert.equal(argv[argv.indexOf("--pids-limit") + 1], "512");
});

test("buildRunArgs hardens the container (no-new-privileges, cap-drop ALL)", () => {
  const argv = buildRunArgs({
    containerName: "swarm-vm-a",
    volume: "swarm-vm-a-workspace",
    image: "node:22-bookworm-slim",
    memory: "2g",
    cpus: "2",
    pidsLimit: "512",
  });

  assert.equal(argv[argv.indexOf("--security-opt") + 1], "no-new-privileges");
  assert.equal(argv[argv.indexOf("--cap-drop") + 1], "ALL");
  assert.ok(argv.includes("--init"));

  const caps: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "--cap-add") caps.push(argv[i + 1]);
  }
  assert.deepEqual(caps, [...VM_CAPABILITIES]);
  // Only the capabilities we asked for are re-added.
  assert.equal(caps.length, new Set(caps).size);
});

test("buildRunArgs refuses to emit an invalid limit", () => {
  const base = {
    containerName: "swarm-vm-a",
    volume: "swarm-vm-a-workspace",
    image: "node:22-bookworm-slim",
    memory: "2g",
    cpus: "2",
    pidsLimit: "512",
  };
  assert.throws(() => buildRunArgs({ ...base, memory: "lots" }), VmLimitError);
  assert.throws(() => buildRunArgs({ ...base, cpus: "0" }), VmLimitError);
  assert.throws(() => buildRunArgs({ ...base, pidsLimit: "-1" }), VmLimitError);
});

test("buildUpdateArgs re-applies the same ceilings to a live container", () => {
  assert.deepEqual(
    buildUpdateArgs({
      containerName: "swarm-vm-a",
      memory: "2g",
      cpus: "2",
      pidsLimit: "512",
    }),
    ["update", "--memory", "2g", "--cpus", "2", "--pids-limit", "512", "swarm-vm-a"],
  );
  assert.throws(
    () => buildUpdateArgs({ containerName: "c", memory: "2g", cpus: "2", pidsLimit: "0" }),
    VmLimitError,
  );
});

// ---------------------------------------------------------------------------
// Driver wiring
// ---------------------------------------------------------------------------

/** Run a body with the given env vars set (restored afterwards). */
function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const VM_LIMIT_ENV = {
  SWARM_VM_MEMORY: undefined,
  SWARM_VM_CPUS: undefined,
  SWARM_VM_PIDS: undefined,
  SWARM_VM_PIDS_LIMIT: undefined,
};

test("DockerVmDriver defaults to 2g memory, 2 cpus and 512 pids", () => {
  withEnv(VM_LIMIT_ENV, () => {
    const driver = new DockerVmDriver();
    assert.equal(driver.memory, "2g");
    assert.equal(driver.cpus, "2");
    assert.equal(driver.pidsLimit, "512");
  });
});

test("DockerVmDriver takes its limits from the environment", () => {
  withEnv(
    {
      ...VM_LIMIT_ENV,
      SWARM_VM_MEMORY: "512m",
      SWARM_VM_CPUS: "1",
      SWARM_VM_PIDS: "128",
    },
    () => {
      const driver = new DockerVmDriver();
      assert.equal(driver.memory, "512m");
      assert.equal(driver.cpus, "1");
      assert.equal(driver.pidsLimit, "128");
    },
  );
});

test("DockerVmDriver rejects an invalid limit from the environment", () => {
  withEnv({ ...VM_LIMIT_ENV, SWARM_VM_MEMORY: "unlimited" }, () => {
    assert.throws(() => new DockerVmDriver(), /Invalid SWARM_VM_MEMORY/);
  });
});

test("DockerVmDriver rejects an invalid explicit limit", () => {
  withEnv(VM_LIMIT_ENV, () => {
    assert.throws(() => new DockerVmDriver({ pidsLimit: "0" }), /at least 1/);
  });
});

// ---------------------------------------------------------------------------
// Runtime selection (SWARM_VM_RUNTIME)
// ---------------------------------------------------------------------------

test("buildRunArgs rejects a runtime outside the allowlist", () => {
  const base = {
    containerName: "swarm-vm-a",
    volume: "swarm-vm-a-workspace",
    image: "node:22-bookworm-slim",
    memory: "2g",
    cpus: "2",
    pidsLimit: "512",
  };
  assert.throws(() => buildRunArgs({ ...base, runtime: "kata" }), VmRuntimeError);
  assert.throws(() => buildRunArgs({ ...base, runtime: "runsc!" }), VmRuntimeError);
});

test("DockerVmDriver defaults to undefined runtime (no --runtime flag)", () => {
  withEnv({ SWARM_VM_RUNTIME: undefined }, () => {
    const driver = new DockerVmDriver();
    assert.equal(driver.runtime, undefined);
  });
});

test("DockerVmDriver takes its runtime from the environment", () => {
  withEnv({ SWARM_VM_RUNTIME: "runsc" }, () => {
    const driver = new DockerVmDriver();
    assert.equal(driver.runtime, "runsc");
  });
});

test("DockerVmDriver lets an explicit runtime override the environment", () => {
  withEnv({ SWARM_VM_RUNTIME: "runc" }, () => {
    const driver = new DockerVmDriver({ runtime: "runsc" });
    assert.equal(driver.runtime, "runsc");
  });
});

test("DockerVmDriver rejects a disallowed runtime from the environment", () => {
  withEnv({ SWARM_VM_RUNTIME: "kata" }, () => {
    assert.throws(() => new DockerVmDriver(), /Invalid SWARM_VM_RUNTIME/);
  });
});

test("DockerVmDriver rejects an invalid explicit runtime", () => {
  withEnv({ SWARM_VM_RUNTIME: undefined }, () => {
    assert.throws(() => new DockerVmDriver({ runtime: "kata" }), VmRuntimeError);
  });
});
