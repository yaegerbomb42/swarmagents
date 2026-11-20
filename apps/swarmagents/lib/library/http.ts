/**
 * Shared HTTP helpers for the Library routes.
 *
 * Every handler calls `libraryOwner(request)`: the middleware has already
 * replaced the user header with the verified session (or harness) id, and in
 * local mode the single account is `local`. A server-mode request without an
 * identity is refused — there is no shared catalog alias for it.
 */

import { NextResponse } from "next/server";
import { providerOwner } from "../providers/owner";
import { LibraryError } from "./types";

export const NO_STORE = { "cache-control": "no-store" } as const;

export const MAX_BODY_BYTES = 256 * 1024;

export function libraryOwner(request: Request): string | null {
  return providerOwner(request);
}

export function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
}

export function jsonError(message: string, status = 400, details?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error: message, ...(details ?? {}) }, { status, headers: NO_STORE });
}

/** Read a bounded JSON body; a malformed or oversized body is a 400/413. */
export async function readJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new LibraryError("Could not read the request body.", 400);
  }
  if (text.length > maxBytes) throw new LibraryError("Request body is too large.", 413);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LibraryError("Invalid JSON body.", 400);
  }
}

/** Map a thrown error to the route response without ever echoing secret data. */
export function errorResponse(error: unknown): NextResponse {
  if (error instanceof LibraryError) {
    return jsonError(error.message, error.status, error.details);
  }
  console.error("[swarm-library] unexpected error:", error instanceof Error ? error.message : String(error));
  return jsonError("The library request failed.", 500);
}

/** Normalize a route param (Next 15 gives a promise). */
export async function routeParam(
  context: { params: Promise<{ id: string }> } | { params: { id: string } },
): Promise<string> {
  const params = await Promise.resolve(context.params);
  return typeof params?.id === "string" ? params.id : "";
}
