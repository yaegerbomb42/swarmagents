/**
 * Owner-only desktop VNC proxy.
 *
 * Next.js route handlers cannot upgrade WebSockets, so the desktop stream is
 * served by this small dedicated Node HTTP server that runs inside the app
 * process (started from instrumentation.ts). It listens on an internal port
 * (default 127.0.0.1:3778); in production a reverse proxy routes the public
 * `/desktop/` path to it. See DEPLOY.md for the nginx/compose wiring.
 *
 * The same server also owns preview WebSocket upgrades
 * (`/preview/<port>/...` session-gated, `/preview/share/<token>/<port>/...`
 * token-gated): the Next.js preview routes can only forward HTTP, so nginx
 * routes preview requests carrying an `Upgrade: websocket` header here
 * (see deploy/nginx.conf) and this server resolves the target through the
 * same choke point as the HTTP routes (`lib/preview/target.ts`) and hands
 * the tunnel to `handlePreviewUpgrade` (`lib/preview/proxy.ts`). That is
 * what makes a Vite HMR / live-reload socket inside a previewed app
 * connect; the app page itself is still served by the Next.js routes.
 *
 * Security properties:
 *   - Every request (HTTP assets and WebSocket upgrades) must carry a valid
 *     session cookie (lib/auth). Nothing is ever served without it.
 *   - The only upstream target is `driver.desktopEndpoint(userId)` for the
 *     authenticated user. Client-supplied host/port/path/query are never used
 *     to choose a target — there is no SSRF surface through headers or params.
 *   - The VNC password is injected server-side into the upstream WebSocket
 *     URL; it is never echoed to the browser, never logged, and never appears
 *     in any response.
 *   - Sessions are `view` (read-only) by default. `control` is granted only
 *     when the client explicitly requests takeover, and only one control
 *     session per user exists at a time. View mode is enforced twice: the
 *     upstream connection is told `viewonly=1`, and RFB input messages are
 *     dropped by the proxy (see rfb-filter.ts).
 *   - Per-user connection limit (default 3 concurrent sessions) and an idle
 *     timeout close abandoned sessions.
 *   - Session opens are recorded in the audit log as desktop.view /
 *     desktop.takeover.
 */

import http from "node:http";
import net from "node:net";
import path from "node:path";
import { URL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  requestUser,
  hostAllowed,
  SESSION_COOKIE,
  type AuthRequestLike,
} from "../auth";
import { recordAudit } from "../audit";
import { getVmManager } from "../vm/manager";
import type { VmDesktopEndpoint } from "../vm/types";
import { handlePreviewUpgrade, type PreviewTarget } from "../preview/proxy";
import { parsePreviewPort, resolvePreviewTarget } from "../preview/target";
import { resolvePreviewShare, type PreviewShareOwner } from "../preview/tokens";
import { resolveShareOwner } from "../projects/store";
import { DesktopBridge } from "./bridge";
import type { RfbFilterMode } from "./rfb-filter";

export const DESKTOP_WS_PATH = "/desktop/ws";
export const DESKTOP_HTTP_PREFIX = "/desktop/";
/** Upgrade requests under this prefix are preview WebSockets, not desktop. */
export const PREVIEW_WS_PREFIX = "/preview/";
/** `/preview/share/<token>/<port>/...` — the token-gated preview mount. */
const PREVIEW_SHARE_RE = /^\/preview\/share\/([^/]+)\/([^/]+)(\/.*)?$/;
/** `/preview/<port>/...` — the session-gated preview mount. */
const PREVIEW_SESSION_RE = /^\/preview\/([^/]+)(\/.*)?$/;

export const DEFAULT_PROXY_PORT = 3778;
export const DEFAULT_PROXY_HOST = "127.0.0.1";
export const DEFAULT_MAX_VIEWERS = 3;
export const DEFAULT_IDLE_MS = 600_000;

/** Hop-by-hop and identity headers stripped before forwarding upstream. */
const STRIPPED_HEADERS = new Set([
  "connection", "upgrade", "keep-alive", "transfer-encoding", "proxy-connection",
  "proxy-authorization", "cookie", "authorization", "x-swarm-user", "host",
]);

export interface DesktopProxyOptions {
  port?: number;
  host?: string;
  /**
   * Resolve the desktop endpoint for an authenticated user. Defaults to the
   * app's VM manager (`getVmManager().desktopEndpoint(userId)`), which is the
   * only allowed target for that user. Tests inject a resolver backed by fake
   * upstreams.
   */
  resolveEndpoint?: (userId: string) => Promise<VmDesktopEndpoint | null>;
  /**
   * Resolve a share token to its owner's userId for guest viewers. Defaults
   * to the projects store's token index. Returns null for an invalid/revoked
   * token, which is refused. Guests are always forced to view-only mode.
   */
  resolveGuest?: (token: string) => Promise<string | null>;
  /** Max concurrent desktop sessions per user. Default 3. */
  maxViewersPerUser?: number;
  /** Idle timeout before a session is closed, ms. Default 10 min. */
  idleMs?: number;
  /** Upstream WebSocket path inside the container (default /websockify). */
  upstreamWsPath?: string;
  /**
   * Name of the upstream query param carrying the view-only hint. The VNC
   * password is never sent in the URL; it travels only in the RFB VNCAuth
   * handshake the proxy performs toward the container.
   */
  upstreamViewonlyParam?: string;
  /**
   * Resolve a preview dial target for (userId, port). Defaults to the
   * app's preview choke point (`resolvePreviewTarget` in
   * lib/preview/target.ts — the port must be in the user's detected
   * listening set). Tests inject a resolver backed by fake upstreams.
   */
  resolvePreviewTarget?: (userId: string, port: number) => Promise<PreviewTarget | null>;
  /**
   * Resolve a preview share token to its owner and port. Defaults to the
   * preview token index (`resolvePreviewShare` in lib/preview/tokens.ts).
   * Tests inject a resolver backed by fake shares.
   */
  resolvePreviewShare?: (token: string) => PreviewShareOwner | null;
  /**
   * Opt-in framebuffer recording (see DesktopBridgeOptions.recordFrames).
   * When true, each desktop session appends only its framebuffer update frames
   * to a capped recording file under `recordingDir`. Default off: zero
   * overhead and zero files.
   */
  recordFrames?: boolean;
  /** Recording directory used when `recordFrames` is true. */
  recordingDir?: string;
  now?: () => number;
}

interface ProxySession {
  id: number;
  userId: string;
  mode: RfbFilterMode;
  sockets: Set<net.Socket>;
  lastActivity: number;
  idleTimer: NodeJS.Timeout | null;
  /** Live bridge for this session (set once the upgrade completes). */
  bridge?: DesktopBridge;
}

export interface DesktopBridgeSessionStatus {
  sessionId: number;
  /** The mode the live bridge is actually enforcing right now. */
  mode: RfbFilterMode;
  /** False once the bridge has failed/closed, or before the upgrade completes. */
  connected: boolean;
  /** True once both handshakes completed and the streams are spliced. */
  spliced: boolean;
}

export interface DesktopProxy {
  readonly server: http.Server;
  /** Port/host the proxy listens on (after listen()). */
  readonly port: number;
  readonly host: string;
  listen(): Promise<void>;
  close(): Promise<void>;
  /** Active sessions per user (exposed for tests/metrics). */
  activeSessions(userId: string): number;
  /**
   * Live per-session bridge status for a user, read from each session's
   * bridge getStatus() — the live enforcement state — never from a stored
   * mode or secret. A session whose upgrade has not completed yet (no
   * bridge) reports its requested mode with connected: false.
   */
  getBridgeStatus(userId: string): DesktopBridgeSessionStatus[];
  /**
   * Force every active desktop session for a user into view or control mode
   * (used by the desktop-handoff runtime to keep the human at the wheel while
   * a handoff is outstanding, and to restore control on hand-back).
   */
  setUserMode(userId: string, mode: RfbFilterMode): void;
}

/**
 * Next.js percent-encodes cookie values when setting them
 * (encodeURIComponent), so a session token for `local_<email>` arrives as
 * `local_james%40example.com`. Decode before verification or the HMAC —
 * computed over the raw user id — never matches and every real user 401s.
 * Malformed encodings fall back to the raw value (verification then fails
 * exactly as it did before decoding existed).
 */
function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseCookieHeader(value: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!value) return out;
  for (const part of value.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      out.set(part.slice(0, idx).trim(), decodeCookieValue(part.slice(idx + 1).trim()));
    }
  }
  return out;
}

function requestLike(req: IncomingMessage): AuthRequestLike {
  const cookies = parseCookieHeader(req.headers.cookie);
  return {
    headers: {
      get(name: string) {
        const lower = name.toLowerCase();
        const value = lower === "cookie" ? req.headers.cookie : req.headers[lower];
        if (value === undefined) return null;
        return Array.isArray(value) ? value[0] : value;
      },
    },
    cookies: {
      get(name: string) {
        const value = cookies.get(name);
        return value !== undefined ? { value } : undefined;
      },
    },
  };
}

function safeError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cache-control": "no-store",
  });
  res.end(message);
}

/** Validate a driver-supplied host: plain IP or DNS name, never a URL. */
function isSafeUpstreamHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  // Reject anything that could smuggle a scheme, path, port or userinfo.
  if (/[/\\@?#\s]/.test(host)) return false;
  // Bracketed IPv6, e.g. [2001:db8::1] (no port — port is supplied separately).
  if (host.startsWith("[") && host.endsWith("]")) {
    return net.isIP(host.slice(1, -1)) === 6;
  }
  const ip = net.isIP(host);
  if (ip === 4 || ip === 6) return true;
  // DNS name fallback (docker network aliases).
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(host);
}

export function createDesktopProxy(opts: DesktopProxyOptions = {}): DesktopProxy {
  const host = opts.host ?? process.env.SWARM_DESKTOP_PROXY_HOST ?? DEFAULT_PROXY_HOST;
  const rawPort = opts.port ?? Number(process.env.SWARM_DESKTOP_PROXY_PORT ?? DEFAULT_PROXY_PORT);
  // 0 means "let the OS pick an ephemeral port" (used by tests).
  const port = Number.isInteger(rawPort) && rawPort >= 0 && rawPort <= 65535 ? rawPort : DEFAULT_PROXY_PORT;
  const maxViewers = Math.max(
    1,
    opts.maxViewersPerUser ?? (Number(process.env.SWARM_DESKTOP_MAX_VIEWERS ?? DEFAULT_MAX_VIEWERS) || DEFAULT_MAX_VIEWERS),
  );
  const idleMs = Math.max(
    1000,
    opts.idleMs ?? (Number(process.env.SWARM_DESKTOP_IDLE_MS ?? DEFAULT_IDLE_MS) || DEFAULT_IDLE_MS),
  );
  const upstreamWsPath = opts.upstreamWsPath ?? process.env.SWARM_VM_DESKTOP_WS_PATH ?? "/websockify";
  const upstreamViewonlyParam = opts.upstreamViewonlyParam ?? process.env.SWARM_VM_DESKTOP_VIEWONLY_PARAM ?? "viewonly";
  const now = opts.now ?? Date.now;

  const server = http.createServer();
  // Reflect the actual bound port once listen() succeeds (an ephemeral port
  // when opts.port is 0) so callers/tests read the real address.
  let boundPort = port;
  const resolveEndpoint = opts.resolveEndpoint ?? ((userId: string) => getVmManager().desktopEndpoint(userId));
  const resolveGuest =
    opts.resolveGuest ??
    (async (token: string): Promise<string | null> => {
      const owner = resolveShareOwner(token);
      return owner ? owner.ownerId : null;
    });
  const resolvePreviewTargetFor =
    opts.resolvePreviewTarget ??
    ((userId: string, port: number) => resolvePreviewTarget(getVmManager(), userId, port));
  const resolvePreviewShareFor =
    opts.resolvePreviewShare ?? ((token: string) => resolvePreviewShare(token));

  const sessionsByUser = new Map<string, Set<ProxySession>>();
  let nextSessionId = 1;

  function sessionsFor(userId: string): Set<ProxySession> {
    let set = sessionsByUser.get(userId);
    if (!set) {
      set = new Set();
      sessionsByUser.set(userId, set);
    }
    return set;
  }

  function touchSession(session: ProxySession): void {
    session.lastActivity = now();
    if (session.idleTimer) clearTimeout(session.idleTimer);
    // Identify this timer: a callback that was already queued when a newer
    // touch() arrived (or that fires a hair before the nominal deadline) must
    // not close a session that is still active.
    const timer = setTimeout(() => {
      if (session.idleTimer !== timer) return;
      closeSession(session, "idle");
    }, idleMs);
    session.idleTimer = timer;
    timer.unref?.();
  }

  function closeSession(session: ProxySession, reason?: string): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
    for (const socket of session.sockets) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
    session.sockets.clear();
    const set = sessionsByUser.get(session.userId);
    set?.delete(session);
    if (set && set.size === 0) sessionsByUser.delete(session.userId);
    if (reason) {
      // The password itself is never logged; only the reason.
      console.warn(`[desktop-proxy] session ${session.id} closed (${reason})`);
    }
  }

  function originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser client; cookie auth still required
    try {
      const originHost = new URL(origin).hostname.toLowerCase();
      const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
      if (originHost === host) return true;
      const allowed = (process.env.SWARM_ALLOWED_HOSTS ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
      return allowed.includes(originHost);
    } catch {
      return false; // malformed Origin cannot be trusted
    }
  }

  async function resolveEndpointFor(userId: string): Promise<VmDesktopEndpoint | null> {
    const endpoint = await resolveEndpoint(userId);
    if (!endpoint) return null;
    if (!isSafeUpstreamHost(endpoint.host) || !Number.isInteger(endpoint.port) ||
        endpoint.port < 1 || endpoint.port > 65535) {
      console.error(`[desktop-proxy] driver returned an invalid desktop endpoint for ${userId}`);
      return null;
    }
    return endpoint;
  }

  // --- HTTP asset proxying (GET/HEAD under /desktop/) -------------------------

  function mapDeskPath(rawPath: string): string | null {
    if (!rawPath.startsWith(DESKTOP_HTTP_PREFIX) && rawPath !== "/desktop") return null;
    const mapped = rawPath.slice(DESKTOP_HTTP_PREFIX.length - 1); // keep leading "/"
    if (mapped.includes("\\") || /[\u0000-\u001f\u007f]/.test(mapped)) return null;
    if (mapped.split("/").includes("..")) return null;
    return mapped === "" ? "/" : mapped;
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return safeError(res, 405, "Method not allowed on /desktop/*");
    }
    if (!hostAllowed(requestLike(req))) return safeError(res, 403, "Forbidden.");
    const user = requestUser(requestLike(req));
    if (!user) return safeError(res, 401, "Sign in required.");
    if (!originAllowed(req)) return safeError(res, 403, "Cross-site request blocked.");

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const mapped = mapDeskPath(url.pathname);
    if (mapped === null) return safeError(res, 404, "Not found.");

    const endpoint = await resolveEndpointFor(user.id);
    if (!endpoint) return safeError(res, 404, "No desktop VM for this user.");

    // Only the driver-resolved host/port is ever dialed. Client-supplied
    // path and query are normalized below — userinfo/credentials never make it
    // into the upstream URL because we construct it from validated pieces.
    const upstreamUrl = new URL(`http://${endpoint.host}:${endpoint.port}${mapped}`);
    upstreamUrl.search = url.search;

    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (name === undefined || value === undefined) continue;
      if (STRIPPED_HEADERS.has(name.toLowerCase())) continue;
      headers[name] = value as string | string[];
    }

    const upReq = http.request(
      {
        host: endpoint.host,
        port: endpoint.port,
        path: upstreamUrl.pathname + upstreamUrl.search,
        method: req.method,
        headers,
      },
      (upRes) => {
        const resHeaders: http.OutgoingHttpHeaders = {
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "cache-control": "no-store",
        };
        for (const [name, value] of Object.entries(upRes.headers)) {
          if (name === undefined || value === undefined) continue;
          if (STRIPPED_HEADERS.has(name.toLowerCase())) continue;
          resHeaders[name] = value as string | string[];
        }
        res.writeHead(upRes.statusCode ?? 502, resHeaders);
        upRes.pipe(res);
      },
    );
    upReq.on("error", () => {
      if (!res.headersSent) return safeError(res, 502, "Upstream desktop unavailable.");
      res.destroy();
    });
    req.pipe(upReq);
  }

  // --- Preview WebSocket upgrades (/preview/<port>/... and /preview/share/<token>/<port>/...) ---

  /**
   * Decode and validate the path inside the previewed app, mirroring
   * lib/preview/serve.ts: percent-decoded segments, re-encoded on the way
   * out; traversal (".", "..", backslash, control chars) is a 404 and the
   * upstream is never dialed. `rest` is the mount remainder including its
   * leading "/" (or undefined when the URL ends at the port); the query
   * string is preserved for the upstream app.
   */
  function previewUpstreamPath(rest: string | undefined, search: string): string | null {
    const segments = (rest ?? "/").split("/").filter((s) => s.length > 0);
    const decoded: string[] = [];
    for (const segment of segments) {
      let part: string;
      try {
        part = decodeURIComponent(segment);
      } catch {
        return null;
      }
      if (part === "." || part === "..") return null;
      if (part.includes("\\") || /[\u0000-\u001f\u007f]/.test(part)) return null;
      decoded.push(part);
    }
    return `/${decoded.map((s) => encodeURIComponent(s)).join("/")}${search}`;
  }

  /**
   * Own the preview half of the `upgrade` event. The shape mirrors the
   * Next.js HTTP routes in app/preview/ (same mounts, same gates, same
   * target choke point) — the only difference is that this runs on a raw
   * server, so the upgrade can actually be accepted:
   *
   *   - Session mount: the caller must hold a valid session cookie for
   *     the VM owner (same gate as the desktop stream); host and origin
   *     are checked first, exactly as for /desktop/ws.
   *   - Share mount: the token is the only credential; it must resolve
   *     and its bound port must equal the port in the path, as in
   *     serveSharedPreview. No session is required or consulted.
   *   - Either way the dial target comes only from
   *     `resolvePreviewTarget` (the port must be in that owner's
   *     detected listening set right now) — a client-supplied port that
   *     is not listening is a 404, never a dial, so there is no SSRF
   *     surface through the path. The session cookie / Authorization
   *     header are never forwarded upstream (handlePreviewUpgrade
   *     strips them, as the HTTP forward does).
   *
   * The tunnel itself (handshake, piping, teardown) is
   * `handlePreviewUpgrade` in lib/preview/proxy.ts; this function only
   * decides who may open it and where it goes.
   */
  async function handlePreviewUpgradeRequest(
    req: IncomingMessage,
    socket: net.Socket,
    head: Buffer,
    url: URL,
  ): Promise<void> {
    if (!hostAllowed(requestLike(req))) {
      return writeUpgradeRefusal(socket, 403, "Forbidden.");
    }
    if (!originAllowed(req)) {
      return writeUpgradeRefusal(socket, 403, "Cross-site request blocked.");
    }

    let ownerId: string;
    let port: number;
    let upstreamPath: string | null;

    const shareMatch = PREVIEW_SHARE_RE.exec(url.pathname);
    if (shareMatch) {
      const [, token, portSegment, rest] = shareMatch;
      const parsed = parsePreviewPort(portSegment);
      if (parsed === null) return writeUpgradeRefusal(socket, 404, "Not found.");
      const share = resolvePreviewShareFor(token);
      if (!share || share.port !== parsed) return writeUpgradeRefusal(socket, 404, "Not found.");
      ownerId = share.ownerId;
      port = parsed;
      upstreamPath = previewUpstreamPath(rest, url.search);
    } else {
      const sessionMatch = PREVIEW_SESSION_RE.exec(url.pathname);
      if (!sessionMatch) return writeUpgradeRefusal(socket, 404, "Not found.");
      const user = requestUser(requestLike(req));
      if (!user) return writeUpgradeRefusal(socket, 401, "Sign in required.");
      const [, portSegment, rest] = sessionMatch;
      const parsed = parsePreviewPort(portSegment);
      if (parsed === null) return writeUpgradeRefusal(socket, 404, "Not found.");
      ownerId = user.id;
      port = parsed;
      upstreamPath = previewUpstreamPath(rest, url.search);
    }
    if (upstreamPath === null) return writeUpgradeRefusal(socket, 404, "Not found.");

    const target = await resolvePreviewTargetFor(ownerId, port);
    if (!target) return writeUpgradeRefusal(socket, 404, "Preview unavailable.");
    await handlePreviewUpgrade(req, socket, head, target, upstreamPath);
  }

  // --- WebSocket proxying (/desktop/ws) --------------------------------------

  function writeUpgradeRefusal(socket: net.Socket, status: number, message: string): void {
    const body = Buffer.from(message);
    socket.write(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\n` +
        "Connection: close\r\n" +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        "Content-Length: " + body.length + "\r\n" +
        "X-Content-Type-Options: nosniff\r\n" +
        "Cache-Control: no-store\r\n" +
        "\r\n",
    );
    socket.end(body);
  }

  async function handleUpgrade(req: IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname.startsWith(PREVIEW_WS_PREFIX)) {
      return handlePreviewUpgradeRequest(req, socket, head, url);
    }
    if (url.pathname !== DESKTOP_WS_PATH) {
      return writeUpgradeRefusal(socket, 404, "Not found.");
    }
    if (!hostAllowed(requestLike(req))) {
      return writeUpgradeRefusal(socket, 403, "Forbidden.");
    }
    // Same gate as the app routes: local mode trusts the machine itself, server
    // mode requires a valid session cookie (or harness bearer, which resolves
    // to the "harness" user — a user with no desktop, so it gets a 404).
    //
    // Guests (public share viewers) carry no session; they authenticate with
    // the share token in the `token` query param, which resolves to the owner
    // and is always forced to view-only mode — a guest can never request
    // control, no matter what query params the client sends.
    if (!originAllowed(req)) {
      return writeUpgradeRefusal(socket, 403, "Cross-site request blocked.");
    }

    let user = requestUser(requestLike(req));
    let guest = false;
    const guestToken = url.searchParams.get("token");
    if (!user && guestToken) {
      const ownerId = await resolveGuest(guestToken);
      if (ownerId) {
        user = { id: ownerId, email: "" };
        guest = true;
      }
    }
    if (!user) {
      return writeUpgradeRefusal(socket, 401, "Sign in required.");
    }

    const wantsControl =
      url.searchParams.get("mode") === "control" || url.searchParams.get("takeover") === "1";
    const mode: RfbFilterMode = guest || !wantsControl ? "view" : "control";

    const endpoint = await resolveEndpointFor(user.id);
    if (!endpoint) return writeUpgradeRefusal(socket, 404, "No desktop VM for this user.");

    const active = sessionsFor(user.id);
    if (active.size >= maxViewers) {
      return writeUpgradeRefusal(socket, 429, "Too many desktop viewers for this user.");
    }
    if (mode === "control" && [...active].some((s) => s.mode === "control")) {
      return writeUpgradeRefusal(socket, 409, "A control session is already active.");
    }

    const session: ProxySession = {
      id: nextSessionId++,
      userId: user.id,
      mode,
      sockets: new Set([socket]),
      lastActivity: now(),
      idleTimer: null,
    };
    active.add(session);
    touchSession(session);

    // The upstream target is exclusively the driver-resolved host/port. The
    // view-only hint travels as a query param; the VNC password travels only
    // inside the RFB VNCAuth handshake performed by the bridge.
    const upstreamPath = upstreamWsPath.startsWith("/") ? upstreamWsPath : `/${upstreamWsPath}`;
    const upstreamUrl = new URL(`http://${endpoint.host}:${endpoint.port}${upstreamPath}`);
    upstreamUrl.searchParams.set(upstreamViewonlyParam, mode === "control" ? "0" : "1");

    const upHeaders: http.OutgoingHttpHeaders = {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": req.headers["sec-websocket-key"] ?? "",
    };
    // Never negotiate permessage-deflate: the proxy inspects/reframes raw
    // WebSocket payloads, so compression must not be enabled in either direction.
    if (req.headers.origin) upHeaders.origin = req.headers.origin as string;

    const upReq = http.request({
      host: endpoint.host,
      port: endpoint.port,
      path: upstreamUrl.pathname + upstreamUrl.search,
      method: "GET",
      headers: upHeaders,
    });

    upReq.on("error", () => {
      closeSession(session, "upstream-unreachable");
      writeUpgradeRefusal(socket, 502, "Upstream desktop unavailable.");
    });

    upReq.on("upgrade", (upRes, upSocket, upHead) => {
      if ((upRes.statusCode ?? 0) !== 101) {
        closeSession(session, "upstream-refused-upgrade");
        upSocket.destroy();
        return writeUpgradeRefusal(socket, 502, "Upstream desktop refused the connection.");
      }
      session.sockets.add(upSocket);
      socket.setNoDelay(true);
      upSocket.setNoDelay(true);
      // Any bytes that arrived with either upgrade (browser frames pipelined
      // after its request, or the container's first RFB frame in the same TCP
      // read as its 101) are fed through the bridge — never written raw, which
      // would bypass the handshake termination and the view-only filter.

      // Echo a minimal 101 to the client, reusing the upstream's accept key
      // (computed from the client's key, so the browser accepts it).
      const accept = (upRes.headers["sec-websocket-accept"] as string | undefined) ?? "";
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          (accept ? `Sec-WebSocket-Accept: ${accept}\r\n` : "") +
          "\r\n",
      );

      socket.on("close", () => closeSession(session, "client-closed"));
      upSocket.on("close", () => closeSession(session, "upstream-closed"));

      // The bridge terminates both RFB handshakes (browser side: no password;
      // upstream side: VNCAuth with the server-side password) and then splices
      // the streams, applying view-mode input filtering.
      const recordingFile =
        opts.recordFrames && opts.recordingDir
          ? path.join(opts.recordingDir, `frames-${session.userId}-${session.id}.rfb`)
          : undefined;
      session.bridge = new DesktopBridge(socket, upSocket, {
        mode: session.mode,
        password: endpoint.password,
        onActivity: () => touchSession(session),
        onClose: (reason) => closeSession(session, reason),
        clientHead: head,
        upstreamHead: upHead,
        recordFrames: opts.recordFrames,
        recordingFile,
      });

      recordAudit({
        user: session.userId,
        action: session.mode === "control" ? "desktop.takeover" : "desktop.view",
        target: session.userId,
        result: "success",
      });
    });

    upReq.end();
  }

  server.on("request", (req, res) => {
    handleRequest(req, res).catch(() => {
      if (!res.headersSent) safeError(res, 500, "Proxy error.");
      else res.destroy();
    });
  });
  server.on("upgrade", (req, socket, head) => {
    handleUpgrade(req, socket as net.Socket, head).catch((err) => {
      console.error("[desktop-proxy] upgrade failed:", err);
      writeUpgradeRefusal(socket as net.Socket, 500, "Proxy error.");
    });
  });

  return {
    server,
    host,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const addr = server.address();
          if (addr && typeof addr === "object" && addr.port) boundPort = addr.port;
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        for (const set of sessionsByUser.values()) {
          for (const session of [...set]) closeSession(session, "proxy-closed");
        }
        server.close(() => resolve());
      });
    },
    activeSessions(userId: string) {
      return sessionsByUser.get(userId)?.size ?? 0;
    },
    getBridgeStatus(userId: string) {
      const set = sessionsByUser.get(userId);
      if (!set) return [];
      return [...set].map((session) => {
        const live = session.bridge?.getStatus();
        return live
          ? { sessionId: session.id, ...live }
          : { sessionId: session.id, mode: session.mode, connected: false, spliced: false };
      });
    },
    setUserMode(userId: string, mode: RfbFilterMode) {
      const set = sessionsByUser.get(userId);
      if (!set) return;
      for (const session of set) {
        session.mode = mode;
        // Takes effect immediately on the live bridge: demoting a control
        // session installs the view filter (blocking further input), and
        // promoting to control removes it.
        session.bridge?.setMode(mode);
      }
    },
    get port() {
      return boundPort;
    },
  };
}

// ---------------------------------------------------------------------------
// Process-wide registry backing the runtime's handoff mode control.
//
// The proxy is created in instrumentation.ts, outside the runtime manager's
// scope. The manager needs to force view/control mode on a user's sessions
// when a desktop handoff starts/ends, so the proxy registers itself here.
// ---------------------------------------------------------------------------

const g = globalThis as typeof globalThis & { __swarmDesktopProxy?: DesktopProxy };

/** Register the running desktop proxy (called once at startup). */
export function setGlobalDesktopProxy(proxy: DesktopProxy | null): void {
  g.__swarmDesktopProxy = proxy ?? undefined;
}

/** The registered desktop proxy, or null when desktop mode is off / not started. */
export function getGlobalDesktopProxy(): DesktopProxy | null {
  return g.__swarmDesktopProxy ?? null;
}
