/**
 * useVmDisplay — the Screen tab's display-availability and close-code
 * contract (l4).
 *
 * The WS display path (l3) already exists — `desktopWsUrl` in
 * lib/client/desktopConfig.ts, the proxy in lib/desktop-proxy, the dial
 * machine in lib/client/desktopState.ts — so this module does not dial
 * anything. It answers the two questions the Screen tab itself has to
 * answer from the signals the browser can actually observe:
 *
 *   1. Is there a desktop to show at all? The task names
 *      GET /api/runtime/vm/display; the live equivalent is the polled
 *      VM status (GET /api/runtime/vm/status, via lib/client/vmStatus):
 *      `desktop` false hides the tab upstream, and a hibernated / error
 *      VM means the tab is shown but the display is unavailable.
 *   2. Why did a dial fail? The proxy closes a refused dial with one of
 *      the 4401 / 4404 / 4503 close codes. noVNC 1.5 swallows the socket's
 *      close code (its `disconnect` event only carries `clean`), so the
 *      UI resolves a refusal from the polled VM state instead — the
 *      mapping itself stays the single source of truth for the codes, so
 *      the day the proxy emits them (or a future noVNC surfaces them) the
 *      same messages apply.
 */

import type { VmDisplayState } from "./vmStatus";

/** The proxy closed the dial: the session is no longer valid. */
export const DISPLAY_CLOSE_SESSION_EXPIRED = 4401;
/** The proxy closed the dial: no desktop exists for this user/agent. */
export const DISPLAY_CLOSE_NOT_FOUND = 4404;
/** The proxy closed the dial: the desktop is unavailable on this server. */
export const DISPLAY_CLOSE_UNAVAILABLE = 4503;

const DISPLAY_CLOSE_MESSAGES: Record<number, string> = {
  [DISPLAY_CLOSE_SESSION_EXPIRED]:
    "Your session expired. Sign in again to view your computer.",
  [DISPLAY_CLOSE_NOT_FOUND]:
    "Desktop not found. The VM may have been reset — reconnect to start a fresh one.",
  [DISPLAY_CLOSE_UNAVAILABLE]: "Desktop not available on this server.",
};

/**
 * Friendly message for a desktop-proxy WebSocket close code, or undefined
 * for codes the Screen tab has no specific copy for (ordinary 1000/1006
 * drops are the reconnecting path, not an error message).
 */
export function describeDisplayClose(code: number): string | undefined {
  return DISPLAY_CLOSE_MESSAGES[code];
}

/**
 * The close code a refused dial most plausibly carries, from the polled
 * VM state: a VM that reported an error has no desktop to serve (4503);
 * anything else refused without a live socket reads as the desktop being
 * gone (4404). The session-expired code (4401) is not reachable from this
 * signal — a signed-out browser is caught by the 401 path first.
 */
export function refusalCloseCode(vmState: VmDisplayState): number {
  return vmState === "error" ? DISPLAY_CLOSE_UNAVAILABLE : DISPLAY_CLOSE_NOT_FOUND;
}

export interface DisplayAvailability {
  /** False when the tab is shown but there is no desktop behind it. */
  available: boolean;
  /** Empty-state copy when available is false. */
  unavailableMessage?: string;
}

/**
 * Map the polled VM display state onto tab availability. A booting VM is
 * available — the connecting skeleton covers the wait — so only the states
 * where no desktop can appear count as unavailable.
 */
export function resolveDisplayAvailability(vmState: VmDisplayState): DisplayAvailability {
  switch (vmState) {
    case "ready":
    case "starting":
      return { available: true };
    case "hibernated":
      return {
        available: false,
        unavailableMessage: "Your computer is hibernated. Wake it to watch the desktop.",
      };
    case "error":
    default:
      return { available: false, unavailableMessage: "Desktop not available on this server" };
  }
}

/** Screen-tab view of the polled VM state: availability plus the close-code map. */
export function useVmDisplay(vmState: VmDisplayState): DisplayAvailability & {
  describeClose: typeof describeDisplayClose;
} {
  return { ...resolveDisplayAvailability(vmState), describeClose: describeDisplayClose };
}
