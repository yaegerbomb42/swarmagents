/**
 * BYOC ("bring your own compute") VM driver.
 *
 * The driver implements the very same {@link VmDriver} contract as the
 * docker driver, but instead of talking to a local container it talks to a
 * paired `swarm-node` runner over the authenticated outbound tunnel. The
 * server sends the same commands it sends to the docker driver (exec, file
 * reads/writes, snapshots, desktop) — the node runs them inside its own
 * sandbox.
 *
 * Security properties:
 *   - the server can never choose where a command runs: `exec` always lands
 *     in the node's sandbox, and the only message that can touch the host
 *     (`hostExec`) is refused by a node that was not started with
 *     --host-mode;
 *   - a command only ever reaches the node that belongs to the calling
 *     account (the hub routes by the paired device, never by client input);
 *   - the desktop password never leaves the server: the browser talks to
 *     the desktop proxy, which injects it into the RFB handshake.
 */

import type {
  ExecOptions,
  ExecResult,
  VmDesktopEndpoint,
  VmDirEntry,
  VmDriver,
  VmFileBytes,
  VmFileStat,
  VmHandle,
  VmSnapshot,
  VmState,
} from "../types";
import {
  ByocNodeDisconnectedError,
  ByocNodeOfflineError,
  getByocHub,
  type ByocHub,
} from "../../byoc/hub";
import { openByocDesktopEndpoint, type ByocDesktopEndpoint } from "../../byoc/desktop-endpoint";

/** Prefix of the synthetic container name a BYOC handle carries. */
export const BYOC_CONTAINER_PREFIX = "byoc-";

/** How long a command waits for its node to come back after a drop. */
export const DEFAULT_BYOC_RESUME_TIMEOUT_MS = 30_000;

export interface ByocVmDriverOptions {
  /** The hub that owns the node sessions (defaults to the process-wide one). */
  hub?: ByocHub;
  /**
   * How long a command waits for the node to reconnect before it gives up.
   * Runs pause while the node is away and resume when it is back.
   */
  resumeTimeoutMs?: number;
}

/** A live desktop endpoint of a paired node. */
interface DesktopEndpointState {
  deviceId: string;
  endpoint: ByocDesktopEndpoint;
}

export class ByocVmDriver implements VmDriver {
  /** BYOC nodes serve a desktop (noVNC) over the tunnel. */
  readonly desktop = true;

  private readonly hub: ByocHub;
  private readonly resumeTimeoutMs: number;
  private readonly devices = new Map<string, string>();
  private readonly desktopEndpoints = new Map<string, DesktopEndpointState>();

  constructor(opts: ByocVmDriverOptions = {}) {
    this.hub = opts.hub ?? getByocHub();
    this.resumeTimeoutMs = opts.resumeTimeoutMs ?? DEFAULT_BYOC_RESUME_TIMEOUT_MS;
  }

  // -------------------------------------------------------------------------
  // Handle plumbing
  // -------------------------------------------------------------------------

  /** The paired device that serves a user (null when none is online). */
  deviceForUser(userId: string): string | null {
    const known = this.devices.get(userId);
    if (known && this.hub.sessionForDevice(known)) return known;
    const deviceId = this.hub.deviceForUser(userId);
    if (deviceId) this.devices.set(userId, deviceId);
    return deviceId;
  }

  /** The device a handle points at, verified to belong to the handle's account. */
  private deviceOf(handle: VmHandle): string {
    let deviceId: string;
    if (handle.containerName.startsWith(BYOC_CONTAINER_PREFIX)) {
      deviceId = handle.containerName.slice(BYOC_CONTAINER_PREFIX.length);
    } else {
      const known = this.devices.get(handle.userId);
      if (!known) throw new ByocNodeOfflineError();
      deviceId = known;
    }
    // A handle must never reach another account's node, even if a caller
    // crafted its containerName. The hub routes by device; we check the
    // session's owner here as defence in depth.
    const session = this.hub.sessionForDevice(deviceId);
    if (!session) throw new ByocNodeOfflineError();
    if (session.userId !== handle.userId) {
      throw new ByocNodeOfflineError(
        "This BYOC node does not belong to the account of this handle.",
      );
    }
    return deviceId;
  }

  /**
   * Run a command against the node, pausing and resuming across a reconnect.
   *
   * When the tunnel drops mid-command the driver waits for the node to come
   * back (bounded by resumeTimeoutMs) and retries the command once, so a
   * flaky network resumes the run instead of failing it.
   */
  private async withResume<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ByocNodeDisconnectedError)) throw err;
      const back = await this.hub.waitForDevice(deviceId, this.resumeTimeoutMs);
      if (!back) throw err;
      return fn();
    }
  }

  // -------------------------------------------------------------------------
  // VmDriver
  // -------------------------------------------------------------------------

  /** Make sure the user's node has a sandbox (idempotent on the node). */
  async ensure(userId: string): Promise<VmHandle> {
    const deviceId = this.deviceForUser(userId);
    if (!deviceId) {
      throw new ByocNodeOfflineError(
        "No BYOC node is online for this account. Pair a node first (Settings → Nodes).",
      );
    }
    await this.withResume(deviceId, () =>
      this.hub.dispatch(deviceId, "ensure", { userId }),
    );
    this.devices.set(userId, deviceId);
    return {
      userId,
      containerName: `${BYOC_CONTAINER_PREFIX}${deviceId}`,
      createdAt: Date.now(),
    };
  }

  /** Run a command inside the node's sandbox, streaming its output. */
  async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    const deviceId = this.deviceOf(handle);
    const payload = {
      userId: handle.userId,
      cmd,
      cwd: opts?.cwd,
      env: opts?.env,
      stdin: opts?.stdin === undefined ? undefined : opts.stdin.toString("utf8"),
      timeoutMs: opts?.timeoutMs,
    };

    let commandId: string | undefined;
    const aborted = new Promise<ExecResult>((resolve) => {
      opts?.signal?.addEventListener(
        "abort",
        () => {
          if (commandId) this.hub.cancel(deviceId, commandId);
          resolve({ exitCode: 130 });
        },
        { once: true },
      );
    });

    const running = this.withResume(deviceId, () =>
      this.hub.dispatch(deviceId, "exec", payload, {
        onStdout: opts?.onStdout,
        onStderr: opts?.onStderr,
        onStart: (id) => {
          commandId = id;
        },
      }),
    );

    const result = await Promise.race([running, aborted]);
    return { exitCode: readExitCode(result) };
  }

  /** Write a file inside the node's sandbox. */
  async writeFile(handle: VmHandle, path: string, content: string): Promise<void> {
    const deviceId = this.deviceOf(handle);
    await this.withResume(deviceId, () =>
      this.hub.dispatch(deviceId, "writeFile", { userId: handle.userId, path, content }),
    );
  }

  /** Read a text file from the node's sandbox. */
  async readFile(handle: VmHandle, path: string): Promise<string> {
    const deviceId = this.deviceOf(handle);
    const result = await this.withResume(deviceId, () =>
      this.hub.dispatch(deviceId, "readFile", { userId: handle.userId, path }),
    );
    return readString(result);
  }

  /** Metadata for one path in the node's sandbox. */
  async stat(handle: VmHandle, path: string): Promise<VmFileStat> {
    const deviceId = this.deviceOf(handle);
    const result = await this.withResume(deviceId, () =>
      this.hub.dispatch(deviceId, "stat", { userId: handle.userId, path }),
    );
    return result as VmFileStat;
  }

  /** One directory level of the node's sandbox. */
  async listDir(handle: VmHandle, path: string): Promise<VmDirEntry[]> {
    const deviceId = this.deviceOf(handle);
    const result = await this.withResume(deviceId, () =>
      this.hub.dispatch(deviceId, "listDir", { userId: handle.userId, path }),
    );
    return (result as VmDirEntry[]) ?? [];
  }

  /** Raw bytes of a file, capped by maxBytes. */
  async readFileBytes(handle: VmHandle, path: string, maxBytes: number): Promise<VmFileBytes> {
    const deviceId = this.deviceOf(handle);
    const result = await this.withResume(deviceId, () =>
      this.hub.dispatch(deviceId, "readFileBytes", {
        userId: handle.userId,
        path,
        maxBytes,
      }),
    );
    const raw = (result ?? {}) as { content?: string; size?: number; truncated?: boolean };
    return {
      content: Buffer.from(raw.content ?? "", "base64"),
      size: raw.size ?? 0,
      truncated: raw.truncated ?? false,
    };
  }

  /** Runtime status of the node's sandbox. */
  async status(handle: VmHandle): Promise<VmState> {
    let deviceId: string;
    try {
      deviceId = this.deviceOf(handle);
    } catch (err) {
      if (err instanceof ByocNodeOfflineError) return { status: "missing" };
      throw err;
    }
    try {
      const result = await this.withResume(deviceId, () =>
        this.hub.dispatch(deviceId, "status", { userId: handle.userId }),
      );
      const raw = (result as { status?: unknown } | null)?.status;
      const status = typeof raw === "string" ? raw : "";
      if (status === "running" || status === "stopped" || status === "creating") {
        return { status };
      }
      return { status: "error", error: "The node reported an unknown status." };
    } catch (err) {
      if (err instanceof ByocNodeOfflineError) return { status: "missing" };
      throw err;
    }
  }

  /** Stop the sandbox (the node keeps the workspace). */
  async stop(handle: VmHandle): Promise<void> {
    const deviceId = this.deviceOf(handle);
    await this.withResume(deviceId, () =>
      this.hub.dispatch(deviceId, "stop", { userId: handle.userId }),
    );
  }

  /** Destroy the sandbox and its workspace. */
  async reset(handle: VmHandle): Promise<void> {
    const deviceId = this.deviceOf(handle);
    await this.withResume(deviceId, () =>
      this.hub.dispatch(deviceId, "reset", { userId: handle.userId }),
    );
    this.devices.delete(handle.userId);
  }

  /** Checkpoint the node's sandbox. */
  async snapshot(handle: VmHandle, label: string): Promise<VmSnapshot> {
    const deviceId = this.deviceOf(handle);
    const result = await this.withResume(deviceId, () =>
      this.hub.dispatch(deviceId, "snapshot", { userId: handle.userId, label }),
    );
    return result as VmSnapshot;
  }

  /** List the node's checkpoints. */
  async listSnapshots(handle: VmHandle): Promise<VmSnapshot[]> {
    const deviceId = this.deviceOf(handle);
    const result = await this.withResume(deviceId, () =>
      this.hub.dispatch(deviceId, "listSnapshots", { userId: handle.userId }),
    );
    return (result as VmSnapshot[]) ?? [];
  }

  /** Restore one of the node's checkpoints. */
  async restore(handle: VmHandle, label: string): Promise<void> {
    const deviceId = this.deviceOf(handle);
    await this.withResume(deviceId, () =>
      this.hub.dispatch(deviceId, "restore", { userId: handle.userId, label }),
    );
  }

  /**
   * The browser-viewable desktop of the node.
   *
   * The desktop proxy dials a loopback endpoint that relays the noVNC
   * stream through the tunnel; the VNC password is injected server-side and
   * never reaches the browser.
   */
  async desktopEndpoint(handle: VmHandle): Promise<VmDesktopEndpoint | null> {
    const deviceId = this.deviceOf(handle);
    const session = this.hub.sessionForDevice(deviceId);
    if (!session) return null;
    if (!session.node.desktop) return null;

    const password = session.desktopPassword ?? "";
    const existing = this.desktopEndpoints.get(handle.userId);
    if (existing && existing.deviceId === deviceId) {
      return { host: existing.endpoint.host, port: existing.endpoint.port, password };
    }
    if (existing) {
      existing.endpoint.close();
      this.desktopEndpoints.delete(handle.userId);
    }

    const endpoint = await openByocDesktopEndpoint({
      hub: this.hub,
      deviceId,
      userId: handle.userId,
    });
    this.desktopEndpoints.set(handle.userId, { deviceId, endpoint });
    return { host: endpoint.host, port: endpoint.port, password };
  }

  /** Drop the cached desktop endpoints (used on shutdown / tests). */
  closeDesktopEndpoints(): void {
    for (const state of this.desktopEndpoints.values()) state.endpoint.close();
    this.desktopEndpoints.clear();
  }
}

/** Read the exit code out of a command result payload. */
function readExitCode(result: unknown): number {
  if (result && typeof result === "object") {
    const exitCode = (result as { exitCode?: unknown }).exitCode;
    if (typeof exitCode === "number" && Number.isFinite(exitCode)) return exitCode;
  }
  return 0;
}

/** Read a string out of a command result payload. */
function readString(result: unknown): string {
  if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (typeof content === "string") return content;
  }
  if (typeof result === "string") return result;
  return "";
}
