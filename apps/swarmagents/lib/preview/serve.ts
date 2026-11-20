/**
 * Shared serving logic for the two preview proxy entry points.
 *
 *   - Session-gated: GET|POST|... /preview/<port>/[...path] — the caller is
 *     the VM owner, authenticated by middleware via the x-swarm-user header
 *     (same gate as the other VM routes). State-changing methods are
 *     additionally refused when the request is cross-site (the same rule
 *     middleware applies to /api/*), because a proxied app's mutating
 *     endpoint must not be drivable from another origin.
 *   - Token-gated: /preview/share/<token>/<port>/[...path] — the token is
 *     the only credential (same model as /share/<token>). The token binds
 *     one owner and one port; the port in the path must equal the token's
 *     port AND be in that owner's detected listening set at request time.
 *
 * Both entry points resolve their target through resolvePreviewTarget, so
 * an unlisted port is never dialed and a host is never taken from the
 * client. Both forward through forwardPreviewRequest, which strips the
 * session cookie before the bytes reach the VM app.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../auth";
import { isCrossSite } from "../request-policy";
import { getVmManager } from "../vm/manager";
import { forwardPreviewRequest, PreviewUpstreamError } from "./proxy";
import { parsePreviewPort, resolvePreviewTarget } from "./target";
import { resolvePreviewShare } from "./tokens";

export const PREVIEW_PROXY_TIMEOUT_MS = 30_000;

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/** Re-encode path segments for the upstream request; null on traversal. */
function upstreamPath(segments: string[] | undefined, search: string): string | null {
  const parts = segments ?? [];
  for (const segment of parts) {
    if (segment === "." || segment === "..") return null;
    if (segment.includes("\\") || /[\u0000-\u001f\u007f]/.test(segment)) return null;
  }
  const path = `/${parts.map((segment) => encodeURIComponent(segment)).join("/")}`;
  return `${path}${search}`;
}

async function forward(
  req: NextRequest,
  mountPrefix: string,
  target: { host: string; port: number },
  subpath: string[] | undefined,
): Promise<Response> {
  const path = upstreamPath(subpath, req.nextUrl.search);
  if (path === null) return jsonError("Not found.", 404);
  try {
    return await forwardPreviewRequest(
      {
        method: req.method,
        path,
        headers: req.headers,
        body: req.body as ReadableStream<Uint8Array> | null,
      },
      target,
      { timeoutMs: PREVIEW_PROXY_TIMEOUT_MS, mountPrefix },
    );
  } catch (err) {
    if (err instanceof PreviewUpstreamError) {
      return jsonError("Upstream preview unavailable.", 502);
    }
    return jsonError("Proxy error.", 500);
  }
}

/**
 * Session-gated preview: the owner's own VM, authenticated by the session
 * header middleware sets. `params.port` is the in-VM port, `params.path`
 * the path inside the previewed app.
 */
export async function serveSessionPreview(
  req: NextRequest,
  params: { port: string; path?: string[] },
): Promise<Response> {
  const user = caller(req);
  if (!user) return jsonError("Sign in required.", 401);
  if (STATE_CHANGING.has(req.method.toUpperCase()) && isCrossSite(req)) {
    return jsonError("Cross-site request blocked.", 403);
  }
  const port = parsePreviewPort(params.port);
  if (port === null) return jsonError("Not found.", 404);
  const target = await resolvePreviewTarget(getVmManager(), user, port);
  if (!target) return jsonError("Preview unavailable.", 404);
  return forward(req, `/preview/${port}`, target, params.path);
}

/**
 * Token-gated preview: anyone holding a live share token can use the
 * preview, for exactly the port that token was minted for.
 */
export async function serveSharedPreview(
  req: NextRequest,
  params: { token: string; port: string; path?: string[] },
): Promise<Response> {
  const port = parsePreviewPort(params.port);
  if (port === null) return jsonError("Not found.", 404);
  const share = resolvePreviewShare(params.token);
  if (!share || share.port !== port) return jsonError("Not found.", 404);
  // The port must still be listening in the owner's VM right now — a token
  // for a stopped app never dials anything.
  const target = await resolvePreviewTarget(getVmManager(), share.ownerId, port);
  if (!target) return jsonError("Preview unavailable.", 404);
  return forward(req, `/preview/share/${params.token}/${port}`, target, params.path);
}
