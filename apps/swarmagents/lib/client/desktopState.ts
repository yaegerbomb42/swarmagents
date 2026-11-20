/**
 * desktopState.ts — pure state machine for the main-page live desktop viewer
 * (the noVNC "Desktop" view of the ComputerScreen).
 *
 * Connection lifecycle the UI shows:
 *
 *   starting     the VM itself is booting (polled status / vm.starting event)
 *   connecting   dialing the desktop websocket proxy
 *   live         the VNC stream is up (red LIVE dot + measured fps)
 *   reconnecting the socket dropped; exponential backoff between dials
 *   offline      backoff exhausted; falls back to the latest screenshot frame
 *
 * The reducer is pure and DOM-free so it unit-tests with plain node:test (see
 * desktopState.test.ts). The component only schedules timers around it.
 */

import { backoffDelayMs, DEFAULT_BACKOFF_BASE_MS, DEFAULT_BACKOFF_MAX_MS } from "./backoff";

export type DesktopPhase =
  | "starting"
  | "connecting"
  | "live"
  | "reconnecting"
  | "offline";

/** Watch = read-only mirror (default); control = the user drives the desktop. */
export type DesktopControlMode = "watch" | "control";

export interface DesktopConnState {
  phase: DesktopPhase;
  /** Consecutive failed dials since the last success; 0 while connected. */
  attempt: number;
  /** Backoff delay scheduled for the next dial in ms; 0 when none is pending. */
  retryInMs: number;
  /** True once this session has seen a live socket (for the LIVE indicator). */
  sawLive: boolean;
  /** True when an offline fallback frame (screenshot) is on display. */
  hasFrame: boolean;
}

export const INITIAL_DESKTOP_CONN: DesktopConnState = {
  phase: "starting",
  attempt: 0,
  retryInMs: 0,
  sawLive: false,
  hasFrame: false,
};

/** Reconnect attempts (drops since the last success) before going offline. */
export const MAX_DESKTOP_ATTEMPTS = 5;

export type DesktopConnEvent =
  /** Polled VM status / telemetry says the sandbox is booting. */
  | { type: "vm-starting" }
  /** The VM reports at least "ready" — begin dialing the proxy. */
  | { type: "vm-ready" }
  /** The proxy websocket opened (VNC handshake may still be in flight). */
  | { type: "open" }
  /** The socket dropped mid-session; reconnect with backoff. */
  | { type: "drop" }
  /** The proxy refused / failed the dial permanently (e.g. desktop off). */
  | { type: "refused" }
  /** The screenshot endpoint returned a frame for offline display. */
  | { type: "fallback-frame" }
  /** The screenshot endpoint had nothing to show. */
  | { type: "no-frame" }
  /** Backoff timer firing: dial again (no-op unless reconnecting). */
  | { type: "retry-due" }
  /** The user explicitly wants to reconnect (also resets the backoff clock). */
  | { type: "retry-now" };

/** Backoff delay for a given reconnect attempt (shared stream schedule). */
export function desktopBackoffMs(attempt: number): number {
  return backoffDelayMs(attempt, {
    baseMs: DEFAULT_BACKOFF_BASE_MS,
    maxMs: DEFAULT_BACKOFF_MAX_MS,
  });
}

/** Enter "connecting": a dial is in flight right now (no pending timer). */
function dialing(s: DesktopConnState, attempt: number): DesktopConnState {
  return {
    ...s,
    phase: "connecting",
    attempt,
    retryInMs: 0,
    hasFrame: false,
  };
}

/**
 * Fold one connection event into the state. Pure: returns a fresh object and
 * never mutates `state`. Unknown events return the state unchanged.
 */
export function reduceDesktopConn(
  state: DesktopConnState,
  event: DesktopConnEvent,
): DesktopConnState {
  const s = state;
  switch (event.type) {
    case "vm-starting":
      // The sandbox is booting — only downgrade when nothing is connected,
      // and keep any fallback frame around (a boot is not a wipe).
      return s.phase === "live" || s.phase === "reconnecting"
        ? s
        : { ...s, phase: "starting", retryInMs: 0 };

    case "vm-ready":
      // Wake the dial loop: after a boot, or when the view first mounts on a
      // ready VM. Refused-to-ready re-arms everything.
      if (s.sawLive && s.phase === "live") return s;
      return dialing(
        { ...s, sawLive: false, hasFrame: false },
        s.phase === "connecting" ? s.attempt : 0,
      );

    case "open":
      return {
        ...s,
        phase: "live",
        attempt: 0,
        retryInMs: 0,
        sawLive: true,
        hasFrame: false,
      };

    case "drop":
      // Live socket died: reconnect with backoff until the attempt budget
      // runs out, then fall back to the offline frame.
      return s.attempt + 1 >= MAX_DESKTOP_ATTEMPTS
        ? { ...s, phase: "offline", attempt: MAX_DESKTOP_ATTEMPTS, retryInMs: 0 }
        : {
            ...s,
            phase: "reconnecting",
            attempt: s.attempt + 1,
            retryInMs: desktopBackoffMs(s.attempt + 1),
          };

    case "refused":
      // Proxy missing / desktop mode off → offline immediately (with whatever
      // fallback frame might still be around so the user sees the VM froze).
      return { ...s, phase: "offline", retryInMs: 0, attempt: MAX_DESKTOP_ATTEMPTS };

    case "fallback-frame":
      return { ...s, hasFrame: true };

    case "no-frame":
      return { ...s, hasFrame: false };

    case "retry-due":
      return s.phase === "reconnecting"
        ? { ...s, phase: "connecting", retryInMs: 0 }
        : s;

    case "retry-now":
      // A deliberate reconnect clears the backoff budget entirely.
      return dialing({ ...s, sawLive: false }, 0);

    default:
      return s;
  }
}

/** Short human label for each phase (badges, ARIA live region). */
export function describeDesktopPhase(phase: DesktopPhase): string {
  switch (phase) {
    case "starting":
      return "starting VM";
    case "connecting":
      return "connecting";
    case "live":
      return "live";
    case "reconnecting":
      return "reconnecting";
    case "offline":
      return "offline";
  }
}
