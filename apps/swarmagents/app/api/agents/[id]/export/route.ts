/**
 * GET /api/agents/{id}/export -> the portable package.
 *
 * Secrets are stripped on the way out *and* the serialized result is re-scanned
 * before it is sent: if any credential-shaped key survives, the export fails
 * with 500 rather than shipping a redacted file silently.
 */

import type { NextRequest } from "next/server";
import { exportAgent, exportContainsSecrets } from "@/lib/agents/store";
import { agentCaller, notFound, ok, routeId, serverError, unauthorized } from "@/lib/agents/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Credential-shaped *values* (not keys): provider tokens, GitHub PATs, cloud
 * access keys, Slack tokens and JWTs. Secret-shaped keys are handled
 * structurally by `exportContainsSecrets`; this catches a secret pasted into
 * free text such as a system prompt. Scanning parsed strings — not the
 * serialized JSON — means a quoted `"token": "..."` example inside a prompt is
 * not mistaken for an object key.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

/** True when any string value in the tree matches a credential-shaped pattern. */
function containsSecretValue(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (typeof value === "string") return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
  if (Array.isArray(value)) return value.some((entry) => containsSecretValue(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((entry) => containsSecretValue(entry, depth + 1));
  }
  return false;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = agentCaller(req);
  if (!user) return unauthorized();
  const id = await routeId(ctx);
  const pkg = exportAgent(user, id);
  if (!pkg) return notFound();
  if (exportContainsSecrets(pkg)) return serverError("Refusing to export: the package still contains secret-shaped keys.");
  if (containsSecretValue(pkg)) return serverError("Refusing to export: the package still contains secret-shaped values.");
  return ok(pkg);
}
