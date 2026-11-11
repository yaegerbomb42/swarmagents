import { NextRequest, NextResponse } from 'next/server';
import { synthesizeDomainRole, listSynthesizedRoles } from '@/lib/lab/agentEvolution';
import { toggleRoleVisibility } from '@/lib/lab/roleLibrary';
import { clientIp, resolveLabIdentity, roleCreateRateLimit } from '@/lib/lab/labAuth';
import { rateLimit } from '@/lib/rateLimit';
import { AGENT_ROLES } from '@/lib/agentRoles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Identity rules (server-enforced — client-supplied ownerId/ownerName are ignored):
 * - Bearer token present  -> verified via Google's public keys; ownerId/ownerName
 *   are derived from the token's `sub` claim.
 * - No bearer token       -> anonymous access pinned to the shared local owner
 *   ('usr-local') so demos/offline dev keep working without impersonation.
 * - Invalid/expired token -> 401.
 * - Publishing (isPublic: true) requires a verified identity; creations always
 *   start private regardless of the request body.
 * - POST (role synthesis) is rate-limited per identity: uid-scoped for verified
 *   users, IP-scoped for anonymous callers (see labAuth.roleCreateRateLimit).
 */

export async function GET(req: NextRequest) {
  const auth = await resolveLabIdentity(req);
  if (auth.ok !== true) return auth.response;
  const ownerId = auth.identity.ownerId;

  try {
    const { searchParams } = new URL(req.url);
    const scope = (searchParams.get('scope') || 'all') as 'all' | 'public' | 'private';

    const roles = await listSynthesizedRoles(ownerId);
    const filtered =
      scope === 'public'
        ? roles.filter((r) => r.isPublic)
        : scope === 'private'
          ? roles.filter((r) => !r.isPublic && r.ownerId === ownerId)
          : roles;

    const builtin = AGENT_ROLES.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      responsibility: r.responsibility,
      tools: r.tools,
      model_tier: r.model_tier,
    }));

    return NextResponse.json({ ok: true, roles: filtered, builtin });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'failed_to_list_roles';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await resolveLabIdentity(req);
  if (auth.ok !== true) return auth.response;

  try {
    const body = await req.json();
    const { domainDescription } = body;

    if (!domainDescription || !String(domainDescription).trim()) {
      return NextResponse.json(
        { ok: false, error: 'missing_domain', detail: 'domainDescription is required' },
        { status: 400 }
      );
    }

    // Per-identity rate limit (LLM synthesis is the expensive path). Checked
    // after input validation so malformed requests don't burn creation quota.
    const rlConfig = roleCreateRateLimit(auth.identity, clientIp(req));
    const rl = await rateLimit(rlConfig.key, rlConfig.limit);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'rate_limited', limit: rlConfig.limit, retry_after: rl.retryAfter },
        {
          status: 429,
          headers: {
            'Retry-After': String(rl.retryAfter),
            'X-RateLimit-Limit': String(rlConfig.limit),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Backend': rl.backend,
          },
        }
      );
    }

    const role = await synthesizeDomainRole(String(domainDescription).trim(), {
      userOrEmail: auth.identity.email || auth.identity.ownerId,
      ownerId: auth.identity.ownerId,
      ownerName: auth.identity.ownerName,
      isPublic: false,
    });

    return NextResponse.json({ ok: true, role });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'role_synthesis_failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await resolveLabIdentity(req);
  if (auth.ok !== true) return auth.response;

  try {
    const body = await req.json();
    const { roleId, isPublic } = body;

    if (!roleId) {
      return NextResponse.json({ ok: false, error: 'missing_role_id' }, { status: 400 });
    }

    if (isPublic === true && auth.identity.anonymous) {
      return NextResponse.json(
        { ok: false, error: 'authentication_required_publish', code: 'auth_required' },
        { status: 401 }
      );
    }

    const role = await toggleRoleVisibility(
      String(roleId),
      Boolean(isPublic),
      auth.identity.ownerId
    );

    if (!role) {
      return NextResponse.json({ ok: false, error: 'role_not_found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, role });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'toggle_failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
