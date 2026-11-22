/**
 * Paired computers (BYOC) for the signed-in account.
 *
 * GET  -> { computers: Computer[] } (newest first, online derived from the
 *         last heartbeat)
 * POST -> { code, expiresAt, install: { linux, macos, windows } }
 *         creates a single-use pairing code and the one-line install command
 *         for each OS. The raw code is returned exactly once and expires.
 *
 * Everything is scoped to the x-swarm-user account; there is no cross-account
 * listing here.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../lib/auth";
import {
  ComputersError,
  MAX_COMPUTERS,
  createPairingCode,
  listComputers,
} from "../../../lib/computers";
import { JsonBodyError, readBoundedText } from "../../../lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;
const MAX_BODY_SIZE = 8 * 1024;
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.\-:[\]]+$/;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function unauthorized() {
  return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
}

const FALLBACK_ORIGIN = "https://swarmagents.codes";

/** Hostnames in SWARM_ALLOWED_HOSTS, lowercased. Empty when unset. */
function allowedHosts(): string[] {
  return (process.env.SWARM_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The public origin a node should call back. Behind the proxy req.nextUrl is
 * the internal host, so prefer the forwarded host when a trusted proxy set
 * it; never echo credentials or a path into the install command.
 *
 * `x-forwarded-host` / `x-forwarded-proto` are client-controlled unless a
 * trusted proxy overwrites them, so they are only read when
 * SWARM_TRUST_PROXY=1. The rightmost forwarded hop is used — the entry the
 * nearest trusted proxy appended — so a client cannot shift the host by
 * prepending entries. When SWARM_ALLOWED_HOSTS is configured, the derived
 * host must be on it; anything else falls back to the public origin, so a
 * spoofed host can never survive into the `curl | sh` install commands.
 */
function requestOrigin(req: NextRequest): string {
  const trusted = process.env.SWARM_TRUST_PROXY === "1";
  const protoHeader = trusted
    ? (req.headers.get("x-forwarded-proto") ?? "")
        .split(",")
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean)
        .pop() ?? ""
    : "";
  const proto = protoHeader === "http" || protoHeader === "https" ? protoHeader : req.nextUrl.protocol.replace(":", "");
  const forwarded = trusted
    ? (req.headers.get("x-forwarded-host") ?? "")
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean)
        .pop() ?? ""
    : "";
  const host = forwarded || (req.headers.get("host") ?? "").trim();
  const candidate = `${proto}://${host}`;
  const allowed = allowedHosts();

  function isAllowed(urlStr: string): boolean {
    if (allowed.length === 0) return true;
    try {
      const hostname = new URL(urlStr).hostname.toLowerCase();
      return allowed.includes(hostname);
    } catch {
      return false;
    }
  }

  if (ORIGIN_RE.test(candidate) && isAllowed(candidate)) {
    return candidate;
  }
  const fallback = req.nextUrl.origin;
  if (ORIGIN_RE.test(fallback) && isAllowed(fallback)) {
    return fallback;
  }
  return FALLBACK_ORIGIN;
}

function installCommands(origin: string, code: string) {
  const base = `${origin}/api/computers/node/install`;
  return {
    linux: `curl -fsSL '${base}?os=linux' | sh -s -- --code ${code} --server '${origin}'`,
    macos: `curl -fsSL '${base}?os=macos' | sh -s -- --code ${code} --server '${origin}'`,
    windows: `& ([scriptblock]::Create((irm '${base}?os=windows'))) -Code '${code}' -Server '${origin}'`,
  };
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();
  return NextResponse.json({ computers: listComputers(user) }, { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();

  // The body is optional today (an empty POST creates a code), but still cap
  // and validate it so a malformed request gets a clean 400. The read is
  // streaming and byte-capped, so an oversized body is rejected with 413
  // before it is buffered.
  let body: unknown = {};
  try {
    const text = await readBoundedText(req, MAX_BODY_SIZE);
    body = text.trim() ? JSON.parse(text) : {};
  } catch (err) {
    if (err instanceof JsonBodyError && err.status === 413) {
      return NextResponse.json({ error: "Request body too large." }, { status: 413, headers: NO_STORE });
    }
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: NO_STORE });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400, headers: NO_STORE });
  }

  try {
    if (listComputers(user).length >= MAX_COMPUTERS) {
      return NextResponse.json(
        { error: `Computer limit reached (${MAX_COMPUTERS}). Revoke one first.` },
        { status: 409, headers: NO_STORE },
      );
    }
    const pairing = createPairingCode(user);
    return NextResponse.json(
      {
        code: pairing.code,
        expiresAt: pairing.expiresAt,
        install: installCommands(requestOrigin(req), pairing.code),
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof ComputersError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: NO_STORE });
    }
    return NextResponse.json({ error: "Could not create a pairing code." }, { status: 500, headers: NO_STORE });
  }
}
