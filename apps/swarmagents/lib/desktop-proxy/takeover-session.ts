/**
 * Per-user takeover session glue: wires the (previously unwired)
 * takeover module — TakeoverStateMachine + HandbackSummarizer in
 * ./takeover/ — into the live desktop proxy's session management.
 *
 * Lifecycle per user:
 *
 *   AGENT_DRIVING --requestTakeover--> HUMAN_REQUESTED
 *   HUMAN_REQUESTED --grant (safe point / paused / timeout)--> HUMAN_DRIVING
 *   HUMAN_REQUESTED --cancel / timeout-deny--> AGENT_DRIVING
 *   HUMAN_DRIVING --handback--> HANDBACK --summary--> AGENT_DRIVING
 *
 * Grant policy: a request is granted immediately when the agent is
 * paused (no run active, or a run blocked on a desktop handoff — the
 * runtime signals this via setAgentPaused). Otherwise it waits for a
 * safe point (notifySafePoint, called by the runtime at tool-result
 * boundaries and run end) and is force-granted (or denied, per
 * configuration) when the request timeout expires. The timeout is the
 * backstop for "safe point may never come"; it lives here, not in the
 * state machine.
 *
 * While HUMAN_DRIVING, a HandbackSummarizer tracks the focused window
 * title (host-side, via a VM exec of xdotool), modified files (via a
 * marker-file diff inside the VM — /workspace is a named docker volume,
 * so host-side fs.watch cannot see it), and input-event count (fed
 * from the RFB input observer in the bridge). On handback the summary
 * is stored on the machine (lastSummary) for the runtime to merge into
 * the ask_human_desktop resolution.
 *
 * Everything VM-facing here is best-effort: a failed exec degrades the
 * summary (fewer titles/files), never the takeover itself.
 */

import { recordAudit, type AuditAction, type AuditResult } from "../audit";
import { getVmManager } from "../vm/manager";
import type { ExecOptions, ExecResult } from "../vm/types";
import { HandbackSummarizer, type WindowTitleProvider } from "./takeover/handback-summarizer";
import {
  StateTransitionError,
  TakeoverStateMachine,
  type TransitionEvent,
} from "./takeover/state-machine";
import type { ControlState, HandbackSummary, InputEvent } from "./takeover/types";

export const DEFAULT_TAKEOVER_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_WINDOW_POLL_MS = 1_500;

/** In-VM marker touched at drive start; handback diffs `find -newer` it. */
const DRIVE_MARKER_PATH = "/tmp/.swarm-takeover-start";
/** Workspace root inside the VM (see VM_WORKSPACE_DISK_PATH in lib/vm/manager). */
const WORKSPACE_ROOT = "/workspace";
/** Cap on files fed to the summarizer from one diff (output hygiene). */
const MAX_DIFF_FILES = 200;
/** Per-exec budget for the title/marker/diff calls. */
const EXEC_TIMEOUT_MS = 3_000;
/** Hard cap on how long handback waits for VM execs before summarizing. */
const FINALIZE_EXEC_BUDGET_MS = 5_000;

export type TakeoverTimeoutMode = "grant" | "deny";

export type TakeoverExec = (
  userId: string,
  cmd: string[],
  opts?: ExecOptions,
) => Promise<ExecResult>;

export interface TakeoverSessionManagerOptions {
  /** Ms a request may sit in HUMAN_REQUESTED before the timeout policy fires. */
  requestTimeoutMs?: number;
  /** What the timeout does: force-grant (default) or deny the request. */
  timeoutMode?: TakeoverTimeoutMode;
  /** VM exec surface (defaults to the app's VM manager). Tests inject fakes. */
  exec?: TakeoverExec;
  /** Window-title poll interval while driving. Default 1_500. */
  windowPollIntervalMs?: number;
  /** Clock override (tests). Defaults to Date.now. */
  now?: () => number;
  /** Audit sink override (tests). Defaults to the app audit log. */
  audit?: (entry: { user: string; action: AuditAction; target: string; result: AuditResult }) => void;
  /**
   * Called after every machine transition (the proxy syncs bridge filter
   * modes from this). Must not throw; the manager guards it anyway.
   */
  onTransition?: (userId: string, event: TransitionEvent) => void;
}

export interface TakeoverStateSnapshot {
  state: ControlState;
  controllerId: string | null;
  agentPaused: boolean;
  /** Epoch ms the pending request arrived; null when none is pending. */
  requestedAt: number | null;
  lastSummary: HandbackSummary | null;
}

interface TakeoverSession {
  machine: TakeoverStateMachine;
  summarizer: HandbackSummarizer | null;
  requestTimer: NodeJS.Timeout | null;
  requestedAt: number | null;
  agentPaused: boolean;
  /** Set while a handback finalize is in flight (re-entrancy guard). */
  finalizing: boolean;
  /**
   * A client that requested control while a handback was finalizing
   * (state HANDBACK). Auto-requested the moment the handback completes,
   * so a dial that lands mid-finalize is queued instead of refused.
   */
  pendingClientId: string | null;
}

/**
 * WindowTitleProvider backed by a VM exec of xdotool. DISPLAY matches the
 * in-VM computer-mcp server (SWARM_COMPUTER_DISPLAY || DISPLAY || ":1").
 * Any failure (no VM, no xdotool, timeout) reads as "" — the summarizer
 * simply records no title for that poll.
 */
export function createVmWindowTitleProvider(exec: TakeoverExec, userId: string): WindowTitleProvider {
  const display = process.env.SWARM_COMPUTER_DISPLAY || process.env.DISPLAY || ":1";
  return {
    async getActiveWindowTitle(): Promise<string> {
      let out = "";
      try {
        const result = await exec(userId, ["xdotool", "getactivewindow", "getwindowname"], {
          env: { DISPLAY: display },
          timeoutMs: EXEC_TIMEOUT_MS,
          onStdout: (chunk) => {
            out += chunk;
          },
        });
        if (result.exitCode !== 0) return "";
      } catch {
        return "";
      }
      return out.trim().slice(0, 200);
    },
  };
}

function timeoutFromEnv(): number {
  const raw = Number(process.env.SWARM_TAKEOVER_REQUEST_TIMEOUT_MS ?? DEFAULT_TAKEOVER_REQUEST_TIMEOUT_MS);
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_TAKEOVER_REQUEST_TIMEOUT_MS;
}

function timeoutModeFromEnv(): TakeoverTimeoutMode {
  return process.env.SWARM_TAKEOVER_TIMEOUT_MODE === "deny" ? "deny" : "grant";
}

function pollFromEnv(): number {
  const raw = Number(process.env.SWARM_TAKEOVER_WINDOW_POLL_MS ?? DEFAULT_WINDOW_POLL_MS);
  return Number.isInteger(raw) && raw >= 250 ? raw : DEFAULT_WINDOW_POLL_MS;
}

export class TakeoverSessionManager {
  private readonly sessions = new Map<string, TakeoverSession>();
  private readonly requestTimeoutMs: number;
  private readonly timeoutMode: TakeoverTimeoutMode;
  private readonly exec: TakeoverExec;
  private readonly windowPollIntervalMs: number;
  private readonly now: () => number;
  private readonly audit: NonNullable<TakeoverSessionManagerOptions["audit"]>;
  private readonly transitionListeners = new Set<
    NonNullable<TakeoverSessionManagerOptions["onTransition"]>
  >();

  constructor(options: TakeoverSessionManagerOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? timeoutFromEnv();
    this.timeoutMode = options.timeoutMode ?? timeoutModeFromEnv();
    this.exec = options.exec ?? ((userId, cmd, opts) => getVmManager().exec(userId, cmd, opts));
    this.windowPollIntervalMs = options.windowPollIntervalMs ?? pollFromEnv();
    this.now = options.now ?? Date.now;
    this.audit = options.audit ?? ((entry) => recordAudit(entry));
    if (options.onTransition) this.transitionListeners.add(options.onTransition);
  }

  /**
   * Register an additional transition listener (the proxy syncs bridge
   * modes from this). Listeners must not throw; the manager guards them.
   */
  addTransitionListener(
    listener: NonNullable<TakeoverSessionManagerOptions["onTransition"]>,
  ): void {
    this.transitionListeners.add(listener);
  }

  /**
   * Ask for control on behalf of a client. Throws StateTransitionError
   * (TAKEOVER_ALREADY_ACTIVE) when another client already holds or awaits
   * control — the proxy maps that to 409. Grants immediately when the
   * agent is paused; otherwise arms the request timeout.
   */
  requestTakeover(userId: string, clientId: string): TransitionEvent {
    const session = this.sessionFor(userId);
    if (session.machine.state === "HANDBACK") {
      // A handback is finalizing (summary execs in flight). Queue this
      // request instead of refusing the dial: it is auto-requested the
      // moment the handback completes. A second queued client conflicts.
      if (session.pendingClientId && session.pendingClientId !== clientId) {
        throw new StateTransitionError(
          "TAKEOVER_ALREADY_ACTIVE",
          "HANDBACK",
          "HUMAN_REQUESTED",
          "A takeover request is already queued behind an in-flight handback",
        );
      }
      session.pendingClientId = clientId;
      session.requestedAt = this.now();
      this.audit({ user: userId, action: "desktop.takeover.request", target: userId, result: "success" });
      return {
        from: "HANDBACK",
        to: "HUMAN_REQUESTED",
        controllerId: clientId,
        reason: "queued_during_handback",
        timestamp: this.now(),
      };
    }
    const event = session.machine.requestTakeover(clientId);
    session.requestedAt = this.now();
    this.audit({ user: userId, action: "desktop.takeover.request", target: userId, result: "success" });
    this.activateRequest(userId, session, event);
    return event;
  }

  /** Post-request wiring shared by fresh and queued requests. */
  private activateRequest(userId: string, session: TakeoverSession, event: TransitionEvent): void {
    this.emitTransition(userId, event);
    if (session.agentPaused) {
      this.grant(userId, session);
    } else {
      this.armRequestTimer(userId, session);
    }
  }

  /**
   * Grant a pending request (the agent reached a safe point). No-op when
   * nothing is pending. Returns true when a grant happened.
   */
  grantTakeover(userId: string): boolean {
    const session = this.sessions.get(userId);
    if (!session || session.machine.state !== "HUMAN_REQUESTED") return false;
    this.grant(userId, session);
    return true;
  }

  /** Runtime hook: a safe point was reached (tool boundary, run end, handoff). */
  notifySafePoint(userId: string): boolean {
    return this.grantTakeover(userId);
  }

  /**
   * Runtime hook: the agent is (not) able to act on the desktop. Paused
   * means no run is active or the active run is blocked waiting for the
   * human — a pending request grants immediately, and future requests
   * grant on arrival.
   */
  setAgentPaused(userId: string, paused: boolean): void {
    const session = this.sessionFor(userId);
    session.agentPaused = paused;
    if (paused) this.grantTakeover(userId);
  }

  /**
   * Hand control back: stop input, finalize the summary, return to
   * AGENT_DRIVING. Resolves with the summary (also stored as lastSummary),
   * or null when there was nothing to hand back. `force` skips the
   * active-controller check (disconnect / runtime force-view paths).
   */
  async handback(
    userId: string,
    clientId: string,
    opts: { force?: boolean } = {},
  ): Promise<HandbackSummary | null> {
    const session = this.sessions.get(userId);
    if (!session || session.finalizing) return null;
    const machine = session.machine;
    if (machine.state === "HUMAN_REQUESTED") {
      // Nothing was driven; a handback of a pending request is a cancel.
      if (!opts.force && machine.controllerId !== clientId) return null;
      this.clearRequestTimer(session);
      session.requestedAt = null;
      const event = machine.cancelTakeoverRequest("handback_before_grant");
      this.emitTransition(userId, event);
      return null;
    }
    if (machine.state !== "HUMAN_DRIVING") return null;
    if (!opts.force && machine.controllerId !== clientId) return null;

    session.finalizing = true;
    try {
      const begin = machine.beginHandback(clientId, opts.force ?? false);
      this.emitTransition(userId, begin);
      const summary = await this.finalizeSummary(userId, session);
      const done = machine.completeHandback(summary);
      this.audit({ user: userId, action: "desktop.handback", target: userId, result: "success" });
      this.emitTransition(userId, done);
      this.drainQueuedRequest(userId, session);
      return summary;
    } finally {
      session.finalizing = false;
    }
  }

  /**
   * A desktop session socket closed. Cancels a pending request or
   * force-handbacks an active drive (with summary). Safe to call for
   * every session close, including view-only and guest sessions.
   */
  async handleDisconnect(
    userId: string,
    clientId: string,
  ): Promise<"cancelled" | "handback" | "noop"> {
    const session = this.sessions.get(userId);
    if (!session) return "noop";
    if (session.pendingClientId === clientId) {
      // The queued requester left before the handback completed.
      session.pendingClientId = null;
      session.requestedAt = null;
      return "cancelled";
    }
    const outcome = session.machine.handleControllerDisconnect(clientId);
    if (outcome === "cancelled") {
      this.clearRequestTimer(session);
      session.requestedAt = null;
      this.emitTransition(userId, {
        from: "HUMAN_REQUESTED",
        to: "AGENT_DRIVING",
        controllerId: null,
        reason: "controller_disconnected",
        timestamp: this.now(),
      });
      return "cancelled";
    }
    if (outcome === "handback_started") {
      // The machine is in HANDBACK; finalize the summary and complete.
      this.emitTransition(userId, {
        from: "HUMAN_DRIVING",
        to: "HANDBACK",
        controllerId: clientId,
        reason: "forced_handback",
        timestamp: this.now(),
      });
      if (!session.finalizing) {
        session.finalizing = true;
        try {
          const summary = await this.finalizeSummary(userId, session);
          const done = session.machine.completeHandback(summary);
          this.audit({ user: userId, action: "desktop.handback", target: userId, result: "success" });
          this.emitTransition(userId, done);
          this.drainQueuedRequest(userId, session);
        } finally {
          session.finalizing = false;
        }
      }
      return "handback";
    }
    return "noop";
  }

  /**
   * Runtime force-view (desktop handoff starting): cancel a pending
   * request or force-handback an active drive. Returns what happened.
   */
  async forceHandback(userId: string): Promise<"cancelled" | "handback" | "noop"> {
    const session = this.sessions.get(userId);
    if (!session) return "noop";
    const controllerId = session.machine.controllerId;
    if (!controllerId) return "noop";
    if (session.machine.state === "HUMAN_REQUESTED") {
      const summary = await this.handback(userId, controllerId, { force: true });
      return summary ? "handback" : "cancelled";
    }
    if (session.machine.state === "HUMAN_DRIVING") {
      await this.handback(userId, controllerId, { force: true });
      return "handback";
    }
    return "noop";
  }

  /** Feed one observed input event; counted only for the active controller. */
  recordInput(userId: string, clientId: string, event: InputEvent): void {
    const session = this.sessions.get(userId);
    if (!session?.summarizer) return;
    if (!session.machine.canAcceptInput(clientId)) return;
    session.summarizer.recordInput(event);
  }

  canAcceptInput(userId: string, clientId: string): boolean {
    return this.sessions.get(userId)?.machine.canAcceptInput(clientId) ?? false;
  }

  getState(userId: string): TakeoverStateSnapshot {
    const session = this.sessions.get(userId);
    if (!session) {
      return {
        state: "AGENT_DRIVING",
        controllerId: null,
        agentPaused: true,
        requestedAt: null,
        lastSummary: null,
      };
    }
    return {
      state: session.machine.state,
      controllerId: session.machine.controllerId,
      agentPaused: session.agentPaused,
      requestedAt: session.requestedAt,
      lastSummary: session.machine.lastSummary,
    };
  }

  getLastSummary(userId: string): HandbackSummary | null {
    return this.sessions.get(userId)?.machine.lastSummary ?? null;
  }

  /** Stop timers/trackers for a user (proxy shutdown). Records are kept. */
  disposeUser(userId: string): void {
    const session = this.sessions.get(userId);
    if (!session) return;
    this.clearRequestTimer(session);
    session.summarizer?.stopTracking();
    session.summarizer = null;
  }

  disposeAll(): void {
    for (const userId of this.sessions.keys()) this.disposeUser(userId);
  }

  // --- internals -------------------------------------------------------------

  /** Auto-request for a client queued during HANDBACK, once it completes. */
  private drainQueuedRequest(userId: string, session: TakeoverSession): void {
    const pending = session.pendingClientId;
    if (!pending) return;
    session.pendingClientId = null;
    if (session.machine.state !== "AGENT_DRIVING") return;
    try {
      // Already audited when queued; activate without a second request entry.
      const event = session.machine.requestTakeover(pending);
      session.requestedAt = this.now();
      this.activateRequest(userId, session, event);
    } catch {
      // The queued client lost the race to another request; it will see
      // AGENT_DRIVING (not controller) on its next state poll and can retry.
    }
  }

  private sessionFor(userId: string): TakeoverSession {
    let session = this.sessions.get(userId);
    if (!session) {
      session = {
        machine: new TakeoverStateMachine(),
        summarizer: null,
        requestTimer: null,
        requestedAt: null,
        // No runtime signal yet: assume nothing is driving, so the first
        // request grants immediately (today's connect-time behavior). The
        // runtime flips this to false when a run starts.
        agentPaused: true,
        finalizing: false,
        pendingClientId: null,
      };
      this.sessions.set(userId, session);
    }
    return session;
  }

  private grant(userId: string, session: TakeoverSession): void {
    this.clearRequestTimer(session);
    session.requestedAt = null;
    const event = session.machine.grantHumanControl();
    this.audit({ user: userId, action: "desktop.takeover", target: userId, result: "success" });
    this.startSummarizer(userId, session);
    this.emitTransition(userId, event);
  }

  private armRequestTimer(userId: string, session: TakeoverSession): void {
    this.clearRequestTimer(session);
    if (this.requestTimeoutMs <= 0) return;
    const timer = setTimeout(() => {
      session.requestTimer = null;
      if (session.machine.state !== "HUMAN_REQUESTED") return;
      if (this.timeoutMode === "deny") {
        session.requestedAt = null;
        const event = session.machine.cancelTakeoverRequest("request_timeout");
        this.audit({ user: userId, action: "desktop.takeover.request", target: userId, result: "failure" });
        this.emitTransition(userId, event);
      } else {
        // Force-grant: the human explicitly asked and has waited the full
        // timeout; this matches today's connect-time control behavior
        // (human + agent may share the desktop until the run pauses).
        this.grant(userId, session);
      }
    }, this.requestTimeoutMs);
    timer.unref?.();
    session.requestTimer = timer;
  }

  private clearRequestTimer(session: TakeoverSession): void {
    if (session.requestTimer) clearTimeout(session.requestTimer);
    session.requestTimer = null;
  }

  private startSummarizer(userId: string, session: TakeoverSession): void {
    session.summarizer?.stopTracking();
    const summarizer = new HandbackSummarizer({
      adapter: createVmWindowTitleProvider(this.exec, userId),
      windowPollIntervalMs: this.windowPollIntervalMs,
    });
    session.summarizer = summarizer;
    // Marker for the handback file diff; best-effort, never blocks the grant.
    void this.exec(userId, ["touch", DRIVE_MARKER_PATH], { timeoutMs: EXEC_TIMEOUT_MS }).catch(() => {});
    void summarizer.startTracking().catch(() => {});
  }

  private async finalizeSummary(userId: string, session: TakeoverSession): Promise<HandbackSummary> {
    const summarizer = session.summarizer;
    session.summarizer = null;
    if (!summarizer) {
      // Should not happen (grant always starts one), but never wedge HANDBACK.
      return {
        text: "Human drove (no activity tracking was available).",
        tokenCount: 8,
        windowTitles: [],
        modifiedFiles: [],
        lastFrameCaption: "",
        durationMs: 0,
        inputEventsCount: 0,
        generatedAt: this.now(),
      };
    }
    await this.collectModifiedFiles(userId, summarizer);
    // No frame tap yet (Task B); the captioner handles a null frame.
    return summarizer.finalize(null);
  }

  private async collectModifiedFiles(userId: string, summarizer: HandbackSummarizer): Promise<void> {
    let out = "";
    try {
      const find = this.exec(
        userId,
        ["find", WORKSPACE_ROOT, "-type", "f", "-newer", DRIVE_MARKER_PATH, "-print"],
        {
          timeoutMs: EXEC_TIMEOUT_MS,
          onStdout: (chunk) => {
            if (out.length < 64 * 1024) out += chunk;
          },
        },
      );
      // find exits non-zero on unreadable dirs; stdout still carries matches.
      await Promise.race([
        find.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, FINALIZE_EXEC_BUDGET_MS)),
      ]);
    } catch {
      return; // best-effort: an unmeasurable diff is an empty diff
    }
    const files = out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(`${WORKSPACE_ROOT}/`) && !line.includes("/.swarm/"))
      .slice(0, MAX_DIFF_FILES);
    for (const file of files) {
      summarizer.recordModifiedFile(file.slice(WORKSPACE_ROOT.length + 1));
    }
  }

  private emitTransition(userId: string, event: TransitionEvent): void {
    for (const listener of this.transitionListeners) {
      try {
        listener(userId, event);
      } catch {
        // A listener bug must never break the takeover lifecycle.
      }
    }
  }
}

export { StateTransitionError };
