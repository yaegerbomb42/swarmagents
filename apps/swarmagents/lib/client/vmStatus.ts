"use client";

/**
 * VM status pill — one display state for the workspace header.
 *
 * Two sources feed the pill:
 *
 *   - the run stream's vm.* lifecycle telemetry (`vm.starting` /
 *     `vm.ready` / `vm.error`), which is immediate while a run is live;
 *   - the polled VM state from GET /api/runtime/vm/status, which is the
 *     only signal that sees idle hibernation (the idle sweeper stops the
 *     VM server-side with no stream event; `stopped` / `missing` there
 *     means hibernated).
 *
 * `resolveVmDisplayStatus` is the pure mapping between those sources and
 * the pill; it is unit-tested in vmStatus.test.ts. The component keeps
 * only the Tailwind styling.
 */

import { useEffect, useState } from "react";
import type { VmStatus } from "../vm/types";

/** Lifecycle events the run stream reports for the VM. */
export type VmLifecycleEvent = "vm.starting" | "vm.ready" | "vm.error";

/** The four states the header pill can show. */
export type VmDisplayState = "starting" | "ready" | "hibernated" | "error";

export interface VmDisplayInput {
  /** Latest vm.* lifecycle event seen on the run stream, if any. */
  latestVmEvent?: VmLifecycleEvent;
  /** Last status polled from GET /api/runtime/vm/status, if any. */
  polledStatus?: VmStatus;
  /** True while a VM reset/wipe is in flight. */
  resetting?: boolean;
  /** Error detail from a vm.error event or a polled error status. */
  errorMessage?: string;
}

export interface VmDisplay {
  state: VmDisplayState;
  /** Short label shown in the pill. */
  label: string;
  /** Tooltip text for the pill. */
  tooltip: string;
}

const VM_DISPLAY_META: Record<VmDisplayState, { label: string; tooltip: string }> = {
  starting: {
    label: "Starting",
    tooltip: "Your computer is starting up — the isolated Linux sandbox is booting.",
  },
  ready: {
    label: "Ready",
    tooltip: "Your computer is ready — the isolated Linux sandbox is running.",
  },
  hibernated: {
    label: "Hibernated",
    tooltip:
      "Your computer is hibernated to save resources after being idle — it will wake automatically the next time you run something.",
  },
  error: {
    label: "Error",
    tooltip: "Your computer reported an error — try resetting it with the red dot.",
  },
};

/**
 * Pick the latest vm.* lifecycle event out of a run-stream item list.
 * Non-vm events are ignored; the last vm event wins, so a `vm.ready`
 * after a `vm.error` clears the error.
 */
export function latestVmLifecycleEvent(
  items: ReadonlyArray<{ kind: string }>,
): VmLifecycleEvent | undefined {
  let latest: VmLifecycleEvent | undefined;
  for (const item of items) {
    if (item.kind === "vm.starting" || item.kind === "vm.ready" || item.kind === "vm.error") {
      latest = item.kind;
    }
  }
  return latest;
}

/**
 * Map the VM's live signals onto the single display state for the pill.
 *
 * Precedence (first match wins):
 *   1. error — a `vm.error` event, or a polled `error` status.
 *   2. starting — a reset in flight, a `vm.starting` event, or a polled
 *      `creating` status.
 *   3. ready — a `vm.ready` event, or a polled `running` status. Telemetry
 *      wins over a stale `stopped` poll here: right after a hibernated VM
 *      wakes, the poll can still say `stopped` while the run already
 *      reported `vm.ready`.
 *   4. hibernated — a polled `stopped` or `missing` status with no fresher
 *      live signal above.
 *   5. ready — default when nothing has reported yet.
 */
export function resolveVmDisplayStatus(input: VmDisplayInput): VmDisplay {
  const { latestVmEvent, polledStatus, resetting, errorMessage } = input;

  let state: VmDisplayState;
  if (latestVmEvent === "vm.error" || polledStatus === "error") {
    state = "error";
  } else if (resetting || latestVmEvent === "vm.starting" || polledStatus === "creating") {
    state = "starting";
  } else if (latestVmEvent === "vm.ready" || polledStatus === "running") {
    state = "ready";
  } else if (polledStatus === "stopped" || polledStatus === "missing") {
    state = "hibernated";
  } else {
    state = "ready";
  }

  const meta = VM_DISPLAY_META[state];
  const tooltip =
    state === "error" && errorMessage
      ? `Your computer reported an error: ${errorMessage} — try resetting it with the red dot.`
      : meta.tooltip;
  return { state, label: meta.label, tooltip };
}

/** How often the pill re-polls GET /api/runtime/vm/status. */
export const VM_STATUS_POLL_MS = 30_000;

/** What the VM status poll knows about the sandbox and this deployment. */
export interface PolledVmInfo {
  /** Latest VM state the server reported (undefined before the first fetch). */
  status?: VmStatus;
  /**
   * True once the server confirmed this deployment runs VMs in desktop mode.
   * Defaults to true (optimistic) until the first response arrives, so the
   * live-desktop screen is the default and only *concedes* to the legacy
   * screen when the server says desktop mode is off.
   */
  desktop: boolean;
}

/**
 * Poll GET /api/runtime/vm/status for the caller's VM state. Silent while
 * the endpoint is unreachable — the pill falls back to the run-stream
 * telemetry (and to `ready` when nothing has reported yet), never an
 * error state of its own. Polling does not wake a hibernated VM: the
 * manager answers status from the known handle without re-ensuring it.
 */
export function usePolledVmStatus(intervalMs: number = VM_STATUS_POLL_MS): PolledVmInfo {
  const [status, setStatus] = useState<VmStatus | undefined>(undefined);
  const [desktop, setDesktop] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/runtime/vm/status");
        if (!res.ok) return;
        const data = (await res.json()) as { status?: unknown; desktop?: unknown };
        if (cancelled) return;
        if (typeof data.status === "string") setStatus(data.status as VmStatus);
        if (typeof data.desktop === "boolean") setDesktop(data.desktop);
      } catch {
        // Unreachable endpoint: keep the last known status (or none).
      }
    };
    void load();
    const id = setInterval(() => void load(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return { status, desktop };
}
