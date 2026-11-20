/**
 * The host side of the in-VM memory bridge.
 *
 * The agent's MCP server runs inside the VM, but the memory store lives on
 * the host (in the app's per-user data directory). The two talk over a tiny
 * file-based RPC: the in-VM server writes a request envelope into the VM's
 * ephemeral /tmp and waits for the host to write the answer next to it.
 *
 * This bridge is that host side: it polls the VM for request envelopes, runs
 * the memory tool against the account's store and writes the answer back.
 * Nothing about the memory is ever written into the VM's persisted volume.
 */

import {
  MEMORY_VM_DIR,
  MEMORY_VM_REQUEST_PREFIX,
  MEMORY_VM_RESPONSE_PREFIX,
  type MemoryToolResult,
} from "./types";

/** The slice of the VM API the bridge needs. */
export interface MemoryBridgeVm {
  listDir(userId: string, path: string): Promise<Array<{ name: string; path: string; type: string }>>;
  readFile(userId: string, path: string): Promise<string>;
  writeFile(userId: string, path: string, content: string): Promise<void>;
}

export interface MemoryBridgeOptions {
  vm: MemoryBridgeVm;
  userId: string;
  /** Runs one memory tool for the account. */
  handle: (tool: string, args: unknown) => Promise<MemoryToolResult>;
  /** How often the VM is polled for new requests. */
  intervalMs?: number;
  /** The RPC directory inside the VM. */
  dir?: string;
}

export interface MemoryBridge {
  /** Stop polling (the pending request is abandoned). */
  stop(): void;
  /** How many requests the bridge has answered. */
  served(): number;
  /** Wait until the bridge is idle (used by tests). */
  idle(): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 250;

/**
 * Start the bridge for one account. The returned handle stops the poller.
 */
export function startMemoryBridge(options: MemoryBridgeOptions): MemoryBridge {
  const { vm, userId, handle } = options;
  const intervalMs = Math.max(50, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const dir = options.dir ?? MEMORY_VM_DIR;

  const seen = new Set<string>();
  let served = 0;
  let stopped = false;
  let running = false;
  let pending: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const entries = await vm.listDir(userId, dir);
      for (const entry of entries) {
        if (stopped) return;
        if (!entry.name.startsWith(MEMORY_VM_REQUEST_PREFIX)) continue;
        if (seen.has(entry.name)) continue;
        seen.add(entry.name);
        // The envelope is named req-<id>.json: the id is what the in-VM
        // server waits for (res-<id>.json).
        const id = entry.name.slice(MEMORY_VM_REQUEST_PREFIX.length).replace(/\.json$/, "");
        let payload: { tool?: unknown; args?: unknown };
        try {
          const raw = await vm.readFile(userId, entry.path);
          payload = JSON.parse(raw) as { tool?: unknown; args?: unknown };
        } catch {
          // A half-written or unreadable envelope: answer with an error so the
          // agent is not left waiting.
          await writeAnswer(vm, userId, dir, id, {
            ok: false,
            error: "bad_request",
            message: "The memory request could not be read.",
          });
          served += 1;
          continue;
        }
        const tool = typeof payload.tool === "string" ? payload.tool : "";
        let answer: MemoryToolResult;
        try {
          answer = await handle(tool, payload.args);
        } catch (error) {
          answer = {
            ok: false,
            error: "tool_failed",
            message: error instanceof Error ? error.message : String(error),
          };
        }
        await writeAnswer(vm, userId, dir, id, answer);
        served += 1;
      }
    } catch {
      // The VM may not be reachable (or the directory may not exist yet):
      // the next tick tries again.
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    pending = pending.then(() => tick()).catch(() => undefined);
  }, intervalMs);
  // Never keep the process alive for the poller.
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    served() {
      return served;
    },
    async idle() {
      await pending;
    },
  };
}

async function writeAnswer(
  vm: MemoryBridgeVm,
  userId: string,
  dir: string,
  id: string,
  answer: MemoryToolResult,
): Promise<void> {
  try {
    await vm.writeFile(userId, `${dir}/${MEMORY_VM_RESPONSE_PREFIX}${id}.json`, JSON.stringify(answer));
  } catch {
    // The VM went away mid-call; the in-VM server times out and reports it.
  }
}
