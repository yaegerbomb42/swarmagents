/**
 * VM preview port detection (F10).
 *
 * When a process inside the user's VM binds a local TCP port (3000, 5173,
 * 8000, ...), the preview proxy needs to know which ports are actually
 * listening so it can (a) list them in the UI and (b) refuse to proxy any
 * port that is not listening — an unlisted port is never dialed, so there is
 * no arbitrary-port SSRF into the container or the host.
 *
 * Detection policy (the sensible default):
 *   - On demand, not on a background timer. A timer would wake hibernated
 *     VMs on every tick; instead the ports API runs detection when its
 *     short-lived cache (TTL 30 s, SWARM_PREVIEW_PORTS_TTL_MS) is stale or
 *     when the client forces a refresh (POST). The Preview tab polls the
 *     API every 30 s, which is the only timer in the loop.
 *   - Never wakes a hibernated VM: detection first asks the manager for the
 *     VM status (which never ensures), and returns an empty list when the
 *     VM is not running in this process. A container that only exists on
 *     disk reads as "missing" until a run or terminal command re-ensures it
 *     — the same convention as the VM status poll.
 *   - `ss -tlnp` first (it names the owning process), falling back to
 *     /proc/net/tcp + /proc/net/tcp6. The fallback is the path that matters:
 *     the VM image does not install iproute2, so `ss` is absent there and
 *     /proc is always present on Linux.
 *
 * Only TCP listen sockets are reported. A small denylist excludes ports
 * that are infrastructure, not apps: 22 (ssh) and 5900/6080 (VNC/desktop —
 * the desktop has its own viewer and must never be served as a preview).
 */

import type { VmManager } from "../vm/manager";

/** Ports that are infrastructure, never previewable apps. */
export const PREVIEW_EXCLUDED_PORTS: ReadonlySet<number> = new Set([22, 5900, 6080]);

/** Default cache TTL for a detected port set (ms). */
export const DEFAULT_PREVIEW_PORTS_TTL_MS = 30_000;

/** Max time a single in-VM probe may take (ms). */
export const PREVIEW_PROBE_TIMEOUT_MS = 10_000;

/** Commands used to enumerate listening TCP ports inside the VM. */
export const SS_CMD = ["ss", "-tlnp"];
export const PROC_NET_CMD = ["cat", "/proc/net/tcp", "/proc/net/tcp6"];

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Parse `ss -tlnp` output. Lines look like:
 *   tcp LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=12,fd=20))
 *   tcp LISTEN 0 4096 [::]:5173   [::]:*   users:(("node",pid=15,fd=21))
 * The local address is field 5 (Netid, State, Recv-Q, Send-Q, Local); the
 * port is after its last ':'.
 */
export function parseSsListening(stdout: string): number[] {
  const ports = new Set<number>();
  for (const line of stdout.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue;
    if (fields[0] !== "tcp" && fields[0] !== "tcp6") continue;
    if (fields[1] !== "LISTEN") continue;
    const local = fields[4] ?? "";
    const colon = local.lastIndexOf(":");
    if (colon < 0) continue;
    const port = Number.parseInt(local.slice(colon + 1), 10);
    if (validPort(port) && !PREVIEW_EXCLUDED_PORTS.has(port)) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * Parse /proc/net/tcp and /proc/net/tcp6 contents. Lines look like:
 *   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 ...
 * The local address is field 2 (`hexip:hexport`); state 0A is LISTEN.
 * tcp6 lines have a 32-hex-digit IP, but the port field is the same shape.
 */
export function parseProcNetListening(content: string): number[] {
  const ports = new Set<number>();
  for (const line of content.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const local = fields[1] ?? "";
    const colon = local.lastIndexOf(":");
    if (colon < 0) continue;
    if (fields[3] !== "0A") continue; // not LISTEN
    const port = Number.parseInt(local.slice(colon + 1), 16);
    if (validPort(port) && !PREVIEW_EXCLUDED_PORTS.has(port)) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** Minimal exec surface `detectListeningPorts` needs (matches VmManager.exec). */
export interface PreviewProbeExec {
  (
    cmd: string[],
    opts?: { onStdout?: (chunk: string) => void; timeoutMs?: number; lane?: "general" | "control" },
  ): Promise<{
    exitCode: number;
  }>;
}

async function runProbe(exec: PreviewProbeExec, cmd: string[]): Promise<string> {
  let stdout = "";
  try {
    await exec(cmd, {
      onStdout: (chunk) => {
        stdout += chunk;
      },
      // Status probe: control lane, so port detection still answers while
      // long tool execs hold every general slot.
      lane: "control",
      timeoutMs: PREVIEW_PROBE_TIMEOUT_MS,
    });
  } catch {
    return "";
  }
  return stdout;
}

/**
 * Detect listening TCP ports inside the VM via `exec`. Tries `ss -tlnp`,
 * then /proc/net/tcp{,6}. Returns a sorted, deduplicated list.
 */
export async function detectListeningPorts(exec: PreviewProbeExec): Promise<number[]> {
  const fromSs = parseSsListening(await runProbe(exec, SS_CMD));
  if (fromSs.length > 0) return fromSs;
  return parseProcNetListening(await runProbe(exec, PROC_NET_CMD));
}

export interface PreviewPortsResult {
  /** True when the VM is running in this process (detection actually ran). */
  running: boolean;
  /** Detected listening ports (previewable), sorted ascending. */
  ports: number[];
  /** Epoch ms of the detection that produced this list (0 when never run). */
  detectedAt: number;
  /** True when this list came from the TTL cache instead of a fresh probe. */
  cached: boolean;
}

interface PortsCacheEntry {
  ports: number[];
  at: number;
}

/** Per-user detection cache (module-level; tests reset it). */
const portsCache = new Map<string, PortsCacheEntry>();

/** Test hook: drop the whole detection cache. */
export function clearPreviewPortsCache(): void {
  portsCache.clear();
}

/** Drop one user's cached detection (used by the force-refresh endpoint). */
export function invalidatePreviewPorts(userId: string): void {
  portsCache.delete(userId);
}

function previewPortsTtlMs(): number {
  const raw = Number(process.env.SWARM_PREVIEW_PORTS_TTL_MS ?? DEFAULT_PREVIEW_PORTS_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_PREVIEW_PORTS_TTL_MS;
}

export interface ListeningPortsOptions {
  /** Skip the cache and probe the VM again. */
  forceRefresh?: boolean;
  /** Cache TTL override (tests). */
  ttlMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

/**
 * Listening ports for the user's VM, with a short-lived cache.
 *
 * Never wakes a hibernated VM: when the manager reports the VM as not
 * running, the result is an empty list and no exec runs. The cache is
 * keyed per user and holds only the detected port numbers — never a host,
 * token, or credential.
 */
export async function listeningPorts(
  manager: VmManager,
  userId: string,
  opts: ListeningPortsOptions = {},
): Promise<PreviewPortsResult> {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? previewPortsTtlMs();
  const at = now();

  const status = await manager.status(userId);
  if (status.status !== "running") {
    return { running: false, ports: [], detectedAt: 0, cached: false };
  }

  if (!opts.forceRefresh) {
    const cached = portsCache.get(userId);
    if (cached && at - cached.at < ttlMs) {
      return { running: true, ports: [...cached.ports], detectedAt: cached.at, cached: true };
    }
  }

  const ports = await detectListeningPorts((cmd, execOpts) => manager.exec(userId, cmd, execOpts));
  portsCache.set(userId, { ports, at });
  return { running: true, ports, detectedAt: at, cached: false };
}

/** True when `port` is a previewable port for the user (in the detected set). */
export async function isPreviewablePort(
  manager: VmManager,
  userId: string,
  port: number,
  opts: ListeningPortsOptions = {},
): Promise<boolean> {
  if (!validPort(port) || PREVIEW_EXCLUDED_PORTS.has(port)) return false;
  const { ports } = await listeningPorts(manager, userId, opts);
  return ports.includes(port);
}
