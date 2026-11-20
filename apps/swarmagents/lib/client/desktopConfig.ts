/**
 * desktopConfig.ts — the single place the browser's live-desktop endpoint
 * paths live.
 *
 * The per-user desktop VM (SWARM_VM_DESKTOP=1) exposes a VNC web client on
 * container port 6080 that is never published to the host. The browser must
 * therefore go through the server-side desktop proxy, which speaks the raw
 * VNC websocket protocol at the d2 contract paths below (the proxy injects
 * the per-container VNC password server-side — it never reaches the browser).
 */

/** How the user is interacting with the desktop. */
export type DesktopMode = "view" | "control";

/**
 * WebSocket proxy path (d2 contract): `?mode=view|control`. View mode is
 * input-disabled on the proxy side; control mode relays pointer/keys.
 */
export const DESKTOP_WS_PATH = "/desktop/ws";

/**
 * Latest-screenshot frame endpoint used when the live socket is unavailable.
 * Captured on demand inside the user's VM (GET /api/runtime/vm/screenshot).
 */
export const DESKTOP_SCREENSHOT_PATH = "/api/runtime/vm/screenshot";

/** Native desktop geometry of the VM image (16:9). */
export const DESKTOP_FRAME_WIDTH = 1600;
export const DESKTOP_FRAME_HEIGHT = 900;

/**
 * Build the browser-safe websocket URL for the desktop proxy. Same-origin by
 * definition: the proxy lives on the app server and fans out to the VM.
 */
export function desktopWsUrl(
  mode: DesktopMode,
  location: { protocol: string; host: string } = globalThis.location,
): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${DESKTOP_WS_PATH}?mode=${mode}`;
}
