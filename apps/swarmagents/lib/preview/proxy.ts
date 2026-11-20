/**
 * Host-side reverse proxy for VM preview tunnels (F10).
 *
 * Forwards one HTTP request to a process listening inside the user's VM.
 * The transport is the same one the desktop proxy uses: the app server dials
 * the VM container's IP on its docker network directly (see
 * VmManager.vmHost / DockerVmDriver.containerIp), which the browser can
 * never reach. The port is never published to the host.
 *
 * The caller — never the client — chooses the target. Both route entry
 * points (session-gated `/preview/<port>/...` and token-gated
 * `/preview/share/<token>/<port>/...`) resolve the target server-side and
 * require the port to be in the detected listening set first (see
 * lib/preview/target.ts), so a client-supplied port can never turn this
 * into an arbitrary-port SSRF: only a currently-listening port in the
 * caller's own VM is dialed.
 *
 * Security properties of the forward itself:
 *   - The browser's session cookie and Authorization header are stripped
 *     before forwarding: the previewed app is agent-built, untrusted code,
 *     and must never receive the user's session.
 *   - Hop-by-hop headers are stripped in both directions.
 *   - Upstream framing headers are replaced with `frame-ancestors 'self'`
 *     + `X-Frame-Options: SAMEORIGIN`, so the in-app Preview tab (a
 *     same-origin iframe) works while no third-party site can frame the
 *     preview — including the public share URL.
 *   - Redirects and cookies that would escape the preview mount point are
 *     rewritten back under it (Location headers and Set-Cookie Path=/).
 *
 * Known limits (by design — Next.js route handlers cannot upgrade
 * WebSockets, which is exactly why the desktop proxy is a separate Node
 * server): the route handlers in app/preview/ cannot receive an upgrade,
 * so Vite HMR / live-reload sockets do not connect through them; the app
 * itself still loads and works. `handlePreviewUpgrade` in this module is
 * the missing half for a raw Node server that owns the `upgrade` event:
 * it performs the upstream handshake and pipes the two sockets, with the
 * same target validation and credential stripping as the HTTP forward.
 * It is wired into the desktop proxy (lib/desktop-proxy/proxy.ts), which
 * accepts upgrades under the same preview mounts
 * (`/preview/<port>/...`, `/preview/share/<token>/<port>/...`) — nginx
 * routes preview requests carrying an `Upgrade: websocket` header there
 * (see deploy/nginx.conf), so a socket that connects under the preview
 * mount upgrades through the proxy while plain HTTP keeps going to the
 * Next.js routes.
 * Apps that emit absolute asset URLs (e.g. Vite with the default base)
 * will 404 their assets under the sub-path mount; apps with relative URLs
 * or `base: './'` work as-is. The response is streamed; there is no HTML
 * rewriting.
 */

import http from "node:http";
import net from "node:net";
import { Readable, type Duplex } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

/** Default upstream timeout (ms); override with SWARM_PREVIEW_PROXY_TIMEOUT_MS. */
export const DEFAULT_PREVIEW_PROXY_TIMEOUT_MS = 30_000;

/** Hop-by-hop and identity headers stripped before forwarding upstream. */
const STRIPPED_REQUEST_HEADERS = new Set([
  "connection",
  "upgrade",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "proxy-connection",
  "proxy-authorization",
  // Identity: the previewed app must never see the user's session.
  "cookie",
  "authorization",
  "x-swarm-user",
  "host",
]);

/** Hop-by-hop headers stripped from the upstream response. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "proxy-connection",
  "upgrade",
  // Framing is re-imposed below (frame-ancestors 'self').
  "x-frame-options",
]);

export interface PreviewTarget {
  host: string;
  port: number;
}

export interface PreviewForwardInput {
  method: string;
  /** Path + query to request upstream, starting with "/". */
  path: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

export interface PreviewForwardOptions {
  /** Upstream timeout in ms (default 30 s). */
  timeoutMs?: number;
  /**
   * Public mount prefix the preview is served under, e.g.
   * "/preview/3000" — absolute-path Location headers and Set-Cookie Path=/
   * are rewritten back under it.
   */
  mountPrefix?: string;
}

/** Thrown when the upstream cannot be reached, times out, or errors. */
export class PreviewUpstreamError extends Error {
  constructor(message = "Upstream preview unavailable.") {
    super(message);
    this.name = "PreviewUpstreamError";
  }
}

/** Validate a driver-supplied host: plain IP or DNS name, never a URL. */
export function isSafeUpstreamHost(host: string): boolean {
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

function previewProxyTimeoutMs(opts: PreviewForwardOptions): number {
  const raw =
    opts.timeoutMs ?? Number(process.env.SWARM_PREVIEW_PROXY_TIMEOUT_MS ?? DEFAULT_PREVIEW_PROXY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PREVIEW_PROXY_TIMEOUT_MS;
}

/**
 * Rewrite an upstream `content-security-policy` so the preview can be framed
 * by the same origin (the in-app Preview tab) and by nothing else. Only the
 * frame-ancestors directive is touched; the app's other directives pass
 * through unchanged.
 */
export function rewriteCspFrameAncestors(csp: string): string {
  const directives = csp
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);
  let replaced = false;
  const rewritten = directives.map((directive) => {
    if (/^frame-ancestors\s/i.test(directive)) {
      replaced = true;
      return "frame-ancestors 'self'";
    }
    return directive;
  });
  if (!replaced) rewritten.push("frame-ancestors 'self'");
  return rewritten.join("; ");
}

/** Rewrite an absolute-path Location back under the preview mount point. */
export function rewriteLocation(location: string, mountPrefix: string | undefined): string {
  if (!mountPrefix) return location;
  // Only same-origin absolute paths ("/..."); protocol-relative ("//..."),
  // absolute URLs and relative paths pass through untouched.
  if (location.startsWith("/") && !location.startsWith("//")) {
    return `${mountPrefix}${location}`;
  }
  return location;
}

/**
 * Rewrite a Set-Cookie header whose Path is "/" (or absent-but-rooted) back
 * under the mount point, so a previewed app's cookies cannot leak onto the
 * whole host origin. Cookies with a narrower explicit Path pass through.
 */
export function rewriteSetCookiePath(setCookie: string, mountPrefix: string | undefined): string {
  if (!mountPrefix) return setCookie;
  const parts = setCookie.split(";").map((part) => part.trim());
  let rewritten = false;
  const out = parts.map((part) => {
    if (/^path=\/$/i.test(part)) {
      rewritten = true;
      return `Path=${mountPrefix}/`;
    }
    return part;
  });
  return rewritten ? out.join("; ") : setCookie;
}

/**
 * Forward one request to the preview target and return the upstream response
 * as a streamed web Response. Throws PreviewUpstreamError when the upstream
 * cannot be reached or times out; the caller maps that to a 502.
 */
export async function forwardPreviewRequest(
  input: PreviewForwardInput,
  target: PreviewTarget,
  opts: PreviewForwardOptions = {},
): Promise<Response> {
  if (!isSafeUpstreamHost(target.host) || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    throw new PreviewUpstreamError("Invalid preview target.");
  }
  const timeoutMs = previewProxyTimeoutMs(opts);
  const mountPrefix = opts.mountPrefix;

  const headers: http.OutgoingHttpHeaders = {};
  input.headers.forEach((value, name) => {
    if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) return;
    headers[name] = value;
  });

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err instanceof PreviewUpstreamError ? err : new PreviewUpstreamError());
    };

    const upReq = http.request(
      {
        host: target.host,
        port: target.port,
        path: input.path,
        method: input.method,
        headers,
        timeout: timeoutMs,
      },
      (upRes) => {
        if (settled) {
          upRes.destroy();
          return;
        }
        settled = true;
        const resHeaders = new Headers();
        resHeaders.set("x-frame-options", "SAMEORIGIN");
        // Never let a previewed app's framing policy (or lack of one) open
        // the preview to third-party framing; 'self' is the whole policy.
        for (const [name, value] of Object.entries(upRes.headers)) {
          if (value === undefined) continue;
          const lower = name.toLowerCase();
          if (STRIPPED_RESPONSE_HEADERS.has(lower)) continue;
          if (lower === "content-security-policy") {
            resHeaders.set(
              "content-security-policy",
              rewriteCspFrameAncestors(Array.isArray(value) ? value.join(", ") : value),
            );
            continue;
          }
          if (lower === "location") {
            resHeaders.set(
              "location",
              rewriteLocation(Array.isArray(value) ? value[0] : value, mountPrefix),
            );
            continue;
          }
          if (lower === "set-cookie") {
            const cookies = Array.isArray(value) ? value : [value];
            for (const cookie of cookies) {
              resHeaders.append("set-cookie", rewriteSetCookiePath(cookie, mountPrefix));
            }
            continue;
          }
          if (Array.isArray(value)) {
            for (const entry of value) resHeaders.append(name, entry);
          } else {
            resHeaders.set(name, value);
          }
        }
        if (!resHeaders.has("content-security-policy")) {
          resHeaders.set("content-security-policy", "frame-ancestors 'self'");
        }
        const status = upRes.statusCode ?? 502;
        // HEAD responses never carry a body, even if the upstream sent one.
        const body =
          input.method === "HEAD" ? null : (Readable.toWeb(upRes) as unknown as ReadableStream<Uint8Array>);
        resolve(new Response(body, { status, headers: resHeaders }));
      },
    );
    upReq.on("timeout", () => {
      upReq.destroy(new PreviewUpstreamError("Upstream preview timed out."));
    });
    upReq.on("error", (err) => {
      fail(err);
    });
    if (input.body) {
      // input.body is the DOM ReadableStream from the fetch Request; fromWeb
      // takes the node:stream/web twin, hence the cast.
      Readable.fromWeb(input.body as unknown as NodeWebReadableStream).pipe(upReq);
    } else {
      upReq.end();
    }
  });
}

// ---------------------------------------------------------------------------
// WebSocket upgrades
// ---------------------------------------------------------------------------

/** Headers forwarded on the upstream WebSocket handshake (identity stripped). */
const WS_FORWARDED_HEADERS = [
  "sec-websocket-protocol",
  "sec-websocket-extensions",
  "sec-websocket-version",
  "origin",
] as const;

/** Hop-by-hop / framing headers never forwarded on an upstream error response. */
const WS_STRIPPED_ERROR_HEADERS = new Set([
  "connection",
  "upgrade",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "trailer",
  "proxy-connection",
]);

export interface PreviewUpgradeOptions {
  /** Upstream handshake timeout in ms (default 30 s). */
  timeoutMs?: number;
}

function writeHttpError(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed || !socket.writable) return;
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

/**
 * Proxy one WebSocket upgrade to the preview target over raw sockets.
 *
 * This is the `upgrade`-event half of the preview proxy: a raw Node server
 * (custom Next server, desktop proxy) calls it from its `server.on(
 * "upgrade", ...)` handler after resolving the target the same way the
 * HTTP routes do (see lib/preview/target.ts) — the target is never taken
 * from the client. Next.js route handlers cannot receive upgrades, so
 * this cannot be wired into app/preview/; see the module comment.
 *
 * `upstreamPath` is the path inside the previewed app (leading "/", mount
 * prefix already stripped). `head` is the bytes that arrived with the
 * client's upgrade request; they are forwarded to the upstream socket
 * before piping, so a frame pipelined behind the handshake is not lost.
 *
 * Security mirrors the HTTP forward: the target host is validated, and
 * the session cookie / Authorization header are never forwarded — the
 * previewed app must never receive the user's session. Origin is
 * forwarded: the upstream app may check it, and it is only the preview
 * origin.
 *
 * The promise resolves once the tunnel is established or the failure
 * response has been written; it never rejects. After a 101 the two
 * sockets are piped bidirectionally and this function is out of the
 * picture — a socket error on either side destroys the other.
 */
export async function handlePreviewUpgrade(
  req: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  target: PreviewTarget,
  upstreamPath: string,
  opts: PreviewUpgradeOptions = {},
): Promise<void> {
  // A socket error before the tunnel exists must not crash the server.
  clientSocket.on("error", () => clientSocket.destroy());

  const reject = (status: number, reason: string): void => {
    writeHttpError(clientSocket, status, reason);
    // end() (not destroy()) so the buffered error response is flushed
    // before the socket closes; destroy() can drop it.
    clientSocket.end();
  };

  if (!isSafeUpstreamHost(target.host) || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    reject(502, "Bad Gateway");
    return;
  }
  const headers = req.headers;
  const connection = String(headers.connection ?? "").toLowerCase();
  if (
    req.method !== "GET" ||
    !connection.split(",").some((part) => part.trim() === "upgrade") ||
    String(headers.upgrade ?? "").toLowerCase() !== "websocket" ||
    typeof headers["sec-websocket-key"] !== "string" ||
    headers["sec-websocket-key"].length === 0 ||
    !upstreamPath.startsWith("/")
  ) {
    reject(400, "Bad Request");
    return;
  }

  const timeoutMs = previewProxyTimeoutMs(opts);
  const upHeaders: http.OutgoingHttpHeaders = {
    connection: "Upgrade",
    upgrade: "websocket",
    host: `${target.host}:${target.port}`,
    "sec-websocket-key": headers["sec-websocket-key"],
  };
  for (const name of WS_FORWARDED_HEADERS) {
    const value = headers[name];
    if (typeof value === "string" && value.length > 0) upHeaders[name] = value;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fail = (status: number, reason: string) => {
      if (settled) return;
      reject(status, reason);
      done();
    };

    const upReq = http.request(
      {
        host: target.host,
        port: target.port,
        path: upstreamPath,
        method: "GET",
        headers: upHeaders,
        timeout: timeoutMs,
      },
      (upRes) => {
        if (settled) {
          upRes.destroy();
          return;
        }
        // The upstream answered with a plain HTTP response instead of 101
        // (e.g. 404 for a path that is not a socket endpoint). Relay it
        // verbatim — status, headers, body — so the client gets a
        // meaningful error instead of a dropped connection. The body is
        // buffered first so the framing headers can be rewritten safely
        // (a streamed chunked body would corrupt the raw socket write).
        const chunks: Buffer[] = [];
        upRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        upRes.on("end", () => {
          if (settled) return;
          const body = Buffer.concat(chunks);
          const status = upRes.statusCode ?? 502;
          const lines = [`HTTP/1.1 ${status} ${upRes.statusMessage ?? ""}`.trimEnd()];
          for (const [name, value] of Object.entries(upRes.headers)) {
            if (value === undefined) continue;
            if (WS_STRIPPED_ERROR_HEADERS.has(name.toLowerCase())) continue;
            if (Array.isArray(value)) {
              for (const entry of value) lines.push(`${name}: ${entry}`);
            } else {
              lines.push(`${name}: ${value}`);
            }
          }
          lines.push(`Content-Length: ${body.length}`);
          lines.push("Connection: close");
          if (!clientSocket.destroyed && clientSocket.writable) {
            // end() (not destroy()) so the buffered relay is flushed
            // before the socket closes; destroy() can drop it.
            clientSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
            clientSocket.end(body);
          } else {
            clientSocket.destroy();
          }
          done();
        });
        upRes.on("error", () => fail(502, "Bad Gateway"));
      },
    );
    upReq.on("timeout", () => {
      upReq.destroy(new PreviewUpstreamError("Upstream preview timed out."));
    });
    upReq.on("error", () => fail(502, "Bad Gateway"));
    upReq.on("upgrade", (upRes, upSocket, upHead) => {
      if (settled) {
        upSocket.destroy();
        return;
      }
      const accept = upRes.headers["sec-websocket-accept"];
      if (typeof accept !== "string" || accept.length === 0) {
        upSocket.destroy();
        fail(502, "Bad Gateway");
        return;
      }
      const lines = [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
      ];
      const protocol = upRes.headers["sec-websocket-protocol"];
      if (typeof protocol === "string" && protocol.length > 0) {
        lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
      }
      if (clientSocket.destroyed || !clientSocket.writable) {
        upSocket.destroy();
        done();
        return;
      }
      clientSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
      // Bytes that arrived with either handshake go first, then pipe.
      if (upHead.length > 0) clientSocket.write(upHead);
      if (head.length > 0) upSocket.write(head);
      upSocket.on("error", () => {
        clientSocket.destroy();
        upSocket.destroy();
      });
      clientSocket.on("error", () => {
        clientSocket.destroy();
        upSocket.destroy();
      });
      // When either side of the tunnel closes, destroy the other.
      // The pipes propagate "end" but not a destroy, so without this
      // a client disconnect leaks the upstream socket — and any
      // server.close() waiting on it hangs forever. Teardown runs on
      // "end" (remote FIN, half-close) as well as "close" (destroy).
      const teardown = () => {
        clientSocket.destroy();
        upSocket.destroy();
      };
      clientSocket.on("close", teardown);
      clientSocket.on("end", teardown);
      upSocket.on("close", teardown);
      upSocket.on("end", teardown);
      clientSocket.pipe(upSocket);
      upSocket.pipe(clientSocket);
      done();
    });
    upReq.end();
  });
}
