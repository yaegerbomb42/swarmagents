/**
 * Project share links (g5).
 *
 * POST   /api/projects/{id}/share -> {share: {token, createdAt}} (create/rotate)
 * DELETE /api/projects/{id}/share -> {ok: true} (revoke; the old token 404s)
 *
 * The token is the only credential the public page accepts. Only the owner can
 * create or revoke it; a non-owner gets 404. The shared view never contains the
 * owner id, provider keys, environment variables, or a live token.
 */

import { type NextRequest } from "next/server";
import { routeCaller, unauthorizedResponse } from "../../../../../lib/auth";
import { recordAudit } from "../../../../../lib/audit";
import { noStoreJson, noStoreRouteError } from "../../../../../lib/http";
import {
  createShareLink,
  getProject,
  isProjectId,
  revokeShareLink,
  setShareShowcase,
} from "../../../../../lib/projects/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function notFound() {
  return noStoreJson({ error: "Project not found." }, { status: 404 });
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = routeCaller(req);
  if (!user) return unauthorizedResponse();
  const { id } = await context.params;
  if (!isProjectId(id)) return notFound();
  if (!getProject(user, id)) return notFound();
  try {
    const share = createShareLink(user, id);
    // Optional replay showcase (core-32): body { runId } curates one finished
    // run's replay onto the public page. Everything exposed is derived from
    // the run's own report server-side and credential-redacted.
    let showcase: unknown = null;
    try {
      const body = (await req.json()) as { runId?: unknown };
      if (body?.runId !== undefined) showcase = setShareShowcase(user, id, body.runId);
    } catch (err) {
      if (err instanceof SyntaxError) {
        // No/invalid body: a plain share rotate is still valid.
      } else {
        throw err;
      }
    }
    recordAudit({ user, action: "project.share.create", target: id, result: "success" });
    return noStoreJson({ share: { token: share.token, createdAt: share.createdAt }, ...(showcase ? { showcase } : {}) });
  } catch (err) {
    recordAudit({ user, action: "project.share.create", target: id, result: "failure" });
    return noStoreRouteError(err, "Could not create the share link.");
  }
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = routeCaller(req);
  if (!user) return unauthorizedResponse();
  const { id } = await context.params;
  if (!isProjectId(id)) return notFound();
  if (!getProject(user, id)) return notFound();
  revokeShareLink(user, id);
  recordAudit({ user, action: "project.share.revoke", target: id, result: "success" });
  return noStoreJson({ ok: true });
}
