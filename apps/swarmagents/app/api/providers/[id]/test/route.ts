/**
 * Test-connection for a single provider: runs the live health probe once for
 * exactly that provider and returns the outcome (ok/latency/error kind). The
 * response never carries key material — only the probe result. Only the
 * caller's own providers can be tested.
 */

import { NextResponse } from "next/server";
import { canonicalProviderId } from "@/lib/providers/catalog";
import { HealthChecker } from "@/lib/providers/health";
import { routerProviders } from "@/lib/providers/store";
import { providerOwner } from "@/lib/providers/owner";
import { checkProviderProbeRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const NO_STORE = { "cache-control": "no-store" } as const;

export async function POST(request: Request, ctx: RouteContext) {
  const owner = providerOwner(request);
  if (!owner) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
  }
  // A probe is a live outbound call per click: bound per user so one
  // account cannot turn the endpoint into an outbound-call flood.
  const limit = checkProviderProbeRateLimit(owner);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many provider tests. Try again later." },
      {
        status: 429,
        headers: { ...NO_STORE, "retry-after": String(limit.retryAfter) },
      },
    );
  }
  const params = await Promise.resolve(ctx.params);
  const rawId = typeof params?.id === "string" ? params.id : "";
  const id = canonicalProviderId(rawId);

  const checker = new HealthChecker({ providers: routerProviders(owner) });
  const health = await checker.checkProvider(id);
  if (!health) {
    return NextResponse.json({ error: "Provider not found." }, { status: 404, headers: NO_STORE });
  }

  return NextResponse.json({ test: health }, { headers: NO_STORE });
}
