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
import { USER_HEADER } from "../../../../../lib/auth";
import { noStoreJson, noStoreRouteError } from "../../../../../lib/http";
import {
  createShareLink,
  getProject,
  isProjectId,
  revokeShareLink,
} from "../../../../../lib/projects/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function notFound() {
  return noStoreJson({ error: "Project not found." }, { status: 404 });
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = caller(req);
  if (!user) return noStoreJson({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  if (!isProjectId(id)) return notFound();
  if (!getProject(user, id)) return notFound();
  try {
    const share = createShareLink(user, id);
    return noStoreJson({ share: { token: share.token, createdAt: share.createdAt } });
  } catch (err) {
    return noStoreRouteError(err, "Could not create the share link.");
  }
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = caller(req);
  if (!user) return noStoreJson({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  if (!isProjectId(id)) return notFound();
  if (!getProject(user, id)) return notFound();
  revokeShareLink(user, id);
  return noStoreJson({ ok: true });
}
