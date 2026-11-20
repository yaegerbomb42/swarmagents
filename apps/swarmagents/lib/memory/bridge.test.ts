import test from "node:test";
import assert from "node:assert/strict";
import { startMemoryBridge, type MemoryBridgeVm } from "./bridge";
import { MEMORY_VM_DIR, MEMORY_VM_REQUEST_PREFIX, MEMORY_VM_RESPONSE_PREFIX } from "./types";
import type { MemoryToolResult } from "./types";

/** An in-memory stand-in for the VM's file API. */
class FakeVm implements MemoryBridgeVm {
  files = new Map<string, string>();

  async listDir(_userId: string, path: string): Promise<Array<{ name: string; path: string; type: string }>> {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const out: Array<{ name: string; path: string; type: string }> = [];
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      out.push({ name: rest, path: file, type: "file" });
    }
    return out;
  }

  async readFile(_userId: string, path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`not found: ${path}`);
    return content;
  }

  async writeFile(_userId: string, path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("the bridge answers a request the in-VM server wrote", async () => {
  const vm = new FakeVm();
  const seen: string[] = [];
  const bridge = startMemoryBridge({
    vm,
    userId: "alice",
    intervalMs: 20,
    handle: async (tool, args): Promise<MemoryToolResult> => {
      seen.push(tool);
      return { ok: true, message: JSON.stringify(args) };
    },
  });

  try {
    const id = "abc123";
    vm.files.set(
      `${MEMORY_VM_DIR}/${MEMORY_VM_REQUEST_PREFIX}${id}.json`,
      JSON.stringify({ id, tool: "memory_write", args: { fact: "hello" } }),
    );

    const responsePath = `${MEMORY_VM_DIR}/${MEMORY_VM_RESPONSE_PREFIX}${id}.json`;
    let answer: MemoryToolResult | null = null;
    for (let i = 0; i < 100 && answer === null; i++) {
      await sleep(20);
      const raw = vm.files.get(responsePath);
      if (raw !== undefined) answer = JSON.parse(raw) as MemoryToolResult;
    }

    assert.ok(answer, "the bridge did not answer the request");
    assert.equal(answer.ok, true);
    assert.match(answer.message ?? "", /hello/);
    assert.deepEqual(seen, ["memory_write"]);
    assert.equal(bridge.served(), 1);
  } finally {
    bridge.stop();
  }
});

test("the bridge answers every request only once", async () => {
  const vm = new FakeVm();
  let calls = 0;
  const bridge = startMemoryBridge({
    vm,
    userId: "alice",
    intervalMs: 20,
    handle: async () => {
      calls += 1;
      return { ok: true };
    },
  });

  try {
    const id = "dup";
    vm.files.set(
      `${MEMORY_VM_DIR}/${MEMORY_VM_REQUEST_PREFIX}${id}.json`,
      JSON.stringify({ id, tool: "memory_search", args: {} }),
    );
    for (let i = 0; i < 20; i++) {
      await sleep(20);
      if (calls > 0) break;
    }
    await sleep(80);
    assert.equal(calls, 1);
  } finally {
    bridge.stop();
  }
});

test("a broken request is answered with an error instead of hanging", async () => {
  const vm = new FakeVm();
  const bridge = startMemoryBridge({
    vm,
    userId: "alice",
    intervalMs: 20,
    handle: async () => {
      throw new Error("store unavailable");
    },
  });

  try {
    const id = "boom";
    vm.files.set(
      `${MEMORY_VM_DIR}/${MEMORY_VM_REQUEST_PREFIX}${id}.json`,
      JSON.stringify({ id, tool: "memory_write", args: {} }),
    );
    const responsePath = `${MEMORY_VM_DIR}/${MEMORY_VM_RESPONSE_PREFIX}${id}.json`;
    let answer: MemoryToolResult | null = null;
    for (let i = 0; i < 100 && answer === null; i++) {
      await sleep(20);
      const raw = vm.files.get(responsePath);
      if (raw !== undefined) answer = JSON.parse(raw) as MemoryToolResult;
    }
    assert.ok(answer);
    assert.equal(answer.ok, false);
    assert.equal(answer.error, "tool_failed");
  } finally {
    bridge.stop();
  }
});

test("the bridge survives a VM that cannot be reached", async () => {
  const bridge = startMemoryBridge({
    vm: {
      listDir: async () => {
        throw new Error("VM is gone");
      },
      readFile: async () => {
        throw new Error("VM is gone");
      },
      writeFile: async () => {
        throw new Error("VM is gone");
      },
    },
    userId: "alice",
    intervalMs: 20,
    handle: async () => ({ ok: true }),
  });
  await sleep(60);
  assert.equal(bridge.served(), 0);
  bridge.stop();
});
