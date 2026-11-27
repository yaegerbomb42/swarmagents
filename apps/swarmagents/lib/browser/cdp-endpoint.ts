/**
 * CDP endpoint resolution for the Browser tab mirror (l10).
 *
 * The Browser tab used to drive its own host-side headless Chromium. It now
 * mirrors the Chromium the agent drives inside the user's VM: the app server
 * connects to it over CDP with `chromium.connectOverCDP`, reaching the
 * browser's debug port (127.0.0.1:9222 inside the VM) through a socat
 * forwarder that listens on the VM's container-network IP at port 9223.
 * The forwarder is started on demand with `vm.exec` the first time a run
 * needs the mirror, and only the app server can reach it — the endpoint URL
 * is server-side only, never sent to the browser client (same ownership rule
 * as the display proxy: the target is always the authenticated user's own
 * VM; no client-supplied host or port is ever used).
 *
 * Backends (see resolveBrowserMode):
 *   - "vm"   — a real VM driver (docker/byoc): mirror the in-VM Chromium.
 *   - "host" — the fake driver with SWARM_BROWSER_HOST=1: keep the current
 *     host-launch behavior (dev/test only).
 *   - "unavailable" — the fake driver without the flag: there is no browser
 *     to mirror, and the UI says so instead of launching a host Chromium.
 */

import { chromium, type Browser } from "playwright-core";
import { defaultDriverName } from "../vm/driver-default";
import { getRun } from "../runtime/run-store";

/** User-facing mirror strings (kept import-free so the UI can use them). */
export { BROWSER_IN_VM_MESSAGE, CDP_NO_TAB_MESSAGE } from "./cdp-messages";

/** Which browser backend the Browser tab uses. */
export type BrowserMode = "vm" | "host" | "unavailable";

/** CDP debug port the VM's Chromium listens on (inside the VM). */
export const CDP_DEBUG_PORT = 9222;
/** Port the socat forwarder exposes the debug port on (VM network IP). */
export const CDP_FORWARD_PORT = 9223;

/** How long one CDP probe may take (ms). */
const CDP_PROBE_TIMEOUT_MS = 2000;
/** How long to keep probing after (re)starting the forwarder (ms). */
const CDP_PROBE_BUDGET_MS = 5000;
/** Delay between probes (ms). */
const CDP_PROBE_INTERVAL_MS = 500;
/** Cap on the forwarder-start exec (ms). */
const CDP_FORWARDER_START_TIMEOUT_MS = 15_000;

/**
 * Resolve the browser backend from the environment. Mirrors the VM driver
 * selection in lib/vm/manager.ts (resolveDriver): the effective driver is
 * SWARM_VM_DRIVER, else the NODE_ENV default (docker in production, fake
 * anywhere else).
 */
export function resolveBrowserMode(env: Readonly<Record<string, string | undefined>> = process.env): BrowserMode {
  const driver = env.SWARM_VM_DRIVER?.trim() || defaultDriverName(env);
  if (driver === "fake") return env.SWARM_BROWSER_HOST === "1" ? "host" : "unavailable";
  return "vm";
}

/** Strict dotted-quad check (no hostnames, no CIDR, no whitespace). */
export function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

/**
 * The socat forwarder start, as a vm.exec argv. Any stale forwarder for the
 * port is killed first and a fresh one is started detached (nohup, output
 * to a bounded log, stdin closed) so the exec returns at once. The VM IP is
 * interpolated only after isValidIpv4 accepted it — never interpolate an
 * unvalidated value into a shell string. Returns null for a non-IPv4 IP.
 */
export function buildSocatForwarderCommand(vmIp: string): string[] | null {
  if (!isValidIpv4(vmIp)) return null;
  // The pkill pattern uses the `922[3]` bracket trick: as a regex it matches
  // the running socat's cmdline (`...:9223`) but NOT this shell's own
  // cmdline, which contains the literal text `922[3]` (not the string
  // `9223`). Without the trick pkill would match — and kill — its own shell.
  const script =
    `pkill -f 'socat TCP-LISTEN:922[3]' 2>/dev/null; ` +
    `(nohup socat TCP-LISTEN:${CDP_FORWARD_PORT},fork,bind=${vmIp} TCP:127.0.0.1:${CDP_DEBUG_PORT} ` +
    `>/tmp/.swarm-cdp-socat.log 2>&1 </dev/null &)`;
  return ["sh", "-c", script];
}

/** A CDP-over-HTTP probe: GET <endpoint>/json/version, parsed as JSON. */
export async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(CDP_PROBE_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`CDP probe ${res.status}`);
  return res.json();
}

/** Dependencies of endpoint resolution (all injectable in tests). */
export interface CdpEndpointDeps {
  /** The user's VM container IP (null when the VM is not running). */
  vmHost: (userId: string) => Promise<string | null>;
  /** Run a command inside the user's VM. */
  exec: (userId: string, cmd: string[], opts?: { timeoutMs?: number }) => Promise<{ exitCode: number }>;
  /** Fetch + parse one JSON document (defaults to a 2s-timeout fetch). */
  fetchJson?: (url: string) => Promise<unknown>;
  /** Clock/sleep, for tests (defaults to Date.now / setTimeout). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** A resolved mirror endpoint. */
export interface CdpEndpoint {
  /** CDP HTTP endpoint, e.g. http://172.18.0.4:9223. */
  url: string;
  /** The VM container IP it was resolved for. */
  vmIp: string;
}

async function probeEndpoint(url: string, fetchJson: (url: string) => Promise<unknown>): Promise<boolean> {
  try {
    const body = (await fetchJson(`${url}/json/version`)) as { webSocketDebuggerUrl?: unknown } | null;
    return typeof body?.webSocketDebuggerUrl === "string" && body.webSocketDebuggerUrl.length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the CDP endpoint for one user's VM: probe the forwarder, start it
 * on demand when the probe fails, then probe again until it answers or the
 * budget runs out. Returns null when the VM is not running, the IP is not a
 * plain IPv4 literal, socat is missing, or Chromium has no debug port open.
 */
export async function resolveCdpEndpointForUser(
  userId: string,
  deps: CdpEndpointDeps,
): Promise<CdpEndpoint | null> {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;

  const vmIp = await deps.vmHost(userId).catch(() => null);
  if (!vmIp || !isValidIpv4(vmIp)) return null;
  const url = `http://${vmIp}:${CDP_FORWARD_PORT}`;

  if (await probeEndpoint(url, fetchJson)) return { url, vmIp };

  const cmd = buildSocatForwarderCommand(vmIp);
  if (!cmd) return null;
  // Best effort: a failed start (socat missing, VM gone) is reported by the
  // probe below, not by the exec result.
  await deps.exec(userId, cmd, { timeoutMs: CDP_FORWARDER_START_TIMEOUT_MS }).catch(() => null);

  const deadline = now() + CDP_PROBE_BUDGET_MS;
  while (now() < deadline) {
    if (await probeEndpoint(url, fetchJson)) return { url, vmIp };
    await sleep(CDP_PROBE_INTERVAL_MS);
  }
  return (await probeEndpoint(url, fetchJson)) ? { url, vmIp } : null;
}

/**
 * Resolve the CDP endpoint for a run, via the run's owner. Returns null when
 * the run is unknown (no owner on record) or its VM has no endpoint.
 */
export async function resolveCdpEndpointForRun(
  runId: string,
  deps: CdpEndpointDeps,
): Promise<CdpEndpoint | null> {
  const owner = getRun(runId)?.summary.userId;
  if (!owner) return null;
  return resolveCdpEndpointForUser(owner, deps);
}

/** The CDP connector a BrowserManager uses to reach the VM browser. */
export interface CdpConnector {
  /** Connect Playwright to a resolved CDP endpoint. */
  connect: (endpoint: string) => Promise<Browser>;
  /** Resolve the CDP endpoint for a run (null when there is none). */
  endpointForRun: (runId: string) => Promise<string | null>;
}

/**
 * The production connector. The vm/manager import is dynamic on purpose:
 * lib/vm/manager.ts imports lib/browser/manager.ts, so a static import
 * here would close a module cycle; the dynamic import runs only when a run
 * actually needs the mirror, long after both modules are loaded.
 */
export function createDefaultCdpConnector(): CdpConnector {
  return {
    connect: (endpoint: string) => chromium.connectOverCDP(endpoint),
    endpointForRun: async (runId: string) => {
      const { getVmManager } = await import("../vm/manager");
      const vm = getVmManager();
      const endpoint = await resolveCdpEndpointForRun(runId, {
        vmHost: (userId: string) => vm.vmHost(userId),
        exec: (userId: string, cmd: string[], opts?: { timeoutMs?: number }) => vm.exec(userId, cmd, opts),
      });
      return endpoint?.url ?? null;
    },
  };
}
