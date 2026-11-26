import { DEFAULT_AGENT_ID, isValidAgentId } from "../vm/agent-keys";

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
 * Takeover-state endpoint on the desktop proxy (proxy-local, session-cookie
 * gated): GET `?client=<id>` returns the caller's takeover state as JSON.
 * Polled while a takeover request is pending.
 */
export const DESKTOP_TAKEOVER_STATE_PATH = "/desktop/takeover-state";

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
 *
 * `clientId` is the takeover identity: the server keys control to it, so the
 * same id must be reused across reconnect-to-switch dials (and on the
 * takeover-state poll) for the session to keep its place in the machine.
 *
 * `runId` tags the viewer's session with the run it is watching, so the proxy
 * can attach its frame recording to that run's report. The proxy validates the
 * id and the caller's ownership; it never trusts this hint for authorization.
 *
 * `agentId` selects which agent's desktop to watch: the proxy serves that
 * agent's own VM. The default agent (A1) is the omission — its desktop is
 * the per-user VM, so no param is sent for it.
 */
function desktopProxyHost(host: string): string {
  // In local Next.js dev (127.0.0.1:3777 / localhost:3777 without nginx),
  // instrumentation.ts serves the WebSocket desktop proxy on port 3778.
  return host === "127.0.0.1:3777" || host === "localhost:3777"
    ? host.replace(/:3777$/, ":3778")
    : host;
}

export function desktopWsUrl(
  mode: DesktopMode,
  location: { protocol: string; host: string } = globalThis.location,
  clientId?: string,
  runId?: string,
  agentId?: string,
): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const client = clientId ? `&client=${encodeURIComponent(clientId)}` : "";
  const run = runId && /^[A-Za-z0-9_-]{1,64}$/.test(runId) ? `&run=${encodeURIComponent(runId)}` : "";
  const agent =
    agentId && agentId !== DEFAULT_AGENT_ID && isValidAgentId(agentId)
      ? `&agent=${encodeURIComponent(agentId)}`
      : "";
  return `${proto}//${desktopProxyHost(location.host)}${DESKTOP_WS_PATH}?mode=${mode}${client}${run}${agent}`;
}

/** Build the takeover-state poll URL for a client id. */
export function desktopTakeoverStateUrl(
  clientId: string,
  location: { protocol: string; host: string } = globalThis.location,
): string {
  return `${location.protocol}//${desktopProxyHost(location.host)}${DESKTOP_TAKEOVER_STATE_PATH}?client=${encodeURIComponent(clientId)}`;
}
