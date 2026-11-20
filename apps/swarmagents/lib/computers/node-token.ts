import type { NextRequest } from "next/server";
import { authenticateComputer } from "./store";

/** Same 64-hex shape the node bearer header accepts. */
export const NODE_TOKEN_RE = /^[A-Fa-f0-9]{64}$/;

/**
 * Bearer token, or the x-computer-token fallback when it is the same 64-hex
 * shape. Anything else is rejected here so the computer store is not queried.
 */
export function nodeTokenFromRequest(req: NextRequest): string | undefined {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+([A-Fa-f0-9]{64})$/.exec(header.trim());
  if (match) return match[1];
  const fallback = req.headers.get("x-computer-token");
  if (!fallback || !NODE_TOKEN_RE.test(fallback.trim())) return undefined;
  return fallback.trim();
}

/** Indirection so tests can prove a bad token never reaches the computer store. */
export const computerAuth = {
  authenticate: authenticateComputer,
};
