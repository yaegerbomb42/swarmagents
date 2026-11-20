/**
 * The caller's role catalog, for the composer's run-access picker.
 *
 * GET /api/runtime/roles -> { roles: PublicRole[] }
 *
 * Built-ins plus the user's own custom roles. The response is deliberately
 * limited to the fields the picker needs to render a name/description; role
 * instructions and the full capability blobs stay server-side. The pre-grant
 * list a client sends back is re-intersected with this same catalog by the
 * runtime manager, so a client can never grant a role the user does not own.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import type { RoleDefinition } from "../../../../lib/roles";
import { userRoleCatalog } from "../../../../lib/roles-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function publicRole(role: RoleDefinition) {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    glyph: role.glyph,
    category: role.category,
    builtin: role.builtin,
    tools: role.tools,
    mcpServers: role.mcpServers,
    lens: role.lens,
  };
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  return NextResponse.json({ roles: userRoleCatalog(user).map(publicRole) });
}
