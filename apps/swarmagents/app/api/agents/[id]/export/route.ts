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
import { SECRET_PATTERNS } from "@/lib/harness/redact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Credential-shaped *values* (not keys): the shared secret shapes from
 * lib/harness/redact (provider tokens, GitHub PATs, cloud access keys,
 * Slack tokens, Gemini keys, PEM headers, Bearer credentials) plus JWTs,
 * which redact does not cover. Secret-shaped keys are handled structurally
 * by `exportContainsSecrets`; this catches a secret pasted into free text
 * such as a system prompt. Scanning parsed strings — not the serialized
 * JSON — means a quoted `"token": "..."` example inside a prompt is not
 * mistaken for an object key.
 *
 * The redact patterns all carry the `g` flag, which makes a shared RegExp
 * stateful under `.test()` (lastIndex drift skips matches on repeat calls),
 * so each pattern is cloned without `g` here.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  ...SECRET_PATTERNS.map(
    ({ pattern }) => new RegExp(pattern.source, pattern.flags.replace(/g/g, "")),
  ),
  // JWTs (3 base64url segments starting with eyJ).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

/**
 * True when any string value in the tree matches a credential-shaped
 * pattern. Fails closed: excessive nesting or a circular reference rejects
 * the export instead of silently skipping the unscanned remainder.
 */
function containsSecretValue(value: unknown, depth = 0, seen = new WeakSet<object>()): boolean {
  if (depth > 20) return true;
  if (typeof value === "string") return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.some((entry) => containsSecretValue(entry, depth + 1, seen));
    return Object.values(value as Record<string, unknown>).some((entry) =>
      containsSecretValue(entry, depth + 1, seen),
    );
  } finally {
    seen.delete(value);
  }
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
