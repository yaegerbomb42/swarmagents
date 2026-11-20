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

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = agentCaller(req);
  if (!user) return unauthorized();
  const id = await routeId(ctx);
  const pkg = exportAgent(user, id);
  if (!pkg) return notFound();
  if (exportContainsSecrets(pkg)) return serverError("Refusing to export: the package still contains secret-shaped keys.");
  const serialized = JSON.stringify(pkg);
  if (/"(?:api[_-]?key|token|secret|password|authorization|credential)[^"]*"\s*:/i.test(serialized)) {
    return serverError("Refusing to export: the serialized package contains secret-shaped keys.");
  }
  return ok(pkg);
}
