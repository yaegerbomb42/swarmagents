import { NextRequest, NextResponse } from 'next/server';
import { forkRoleCard } from '@/lib/lab/roleLibrary';
import { resolveLabIdentity } from '@/lib/lab/labAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/lab/roles/fork — copy a role into the caller's library as a
 * private draft. The fork owner is always derived from the verified identity
 * (or pinned to the shared local owner for anonymous callers); client-supplied
 * ownerId/ownerName are ignored.
 */
export async function POST(req: NextRequest) {
  const auth = await resolveLabIdentity(req);
  if (auth.ok !== true) return auth.response;

  try {
    const body = await req.json();
    const { roleId } = body;

    if (!roleId) {
      return NextResponse.json({ ok: false, error: 'missing_role_id' }, { status: 400 });
    }

    const role = await forkRoleCard(String(roleId), {
      ownerId: auth.identity.ownerId,
      ownerName: auth.identity.ownerName,
    });

    if (!role) {
      return NextResponse.json({ ok: false, error: 'role_not_found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, role });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'fork_failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
