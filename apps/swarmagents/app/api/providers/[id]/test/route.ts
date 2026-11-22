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
import { TokenBucket } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const NO_STORE = { "cache-control": "no-store" } as const;

function perMinute(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Live outbound probes are expensive; budget them per user. */
const probeBucket = new TokenBucket(
  perMinute("SWARM_PROVIDERS_TEST_RATE_LIMIT_PER_MIN", 20),
  60_000,
);

function json(body: unknown, status = 200, extraHeaders?: HeadersInit): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { ...NO_STORE, ...(extraHeaders ?? {}) },
  });
}

export async function POST(request: Request, ctx: RouteContext) {
  const owner = providerOwner(request);
  if (!owner) {
    return json({ error: "Sign in required." }, 401);
  }

  const rate = probeBucket.consume(`providers-test:${owner}`);
  if (!rate.allowed) {
    return json(
      { error: "Too many provider probes — try again in a moment." },
      429,
      { "Retry-After": String(rate.retryAfter) },
    );
  }

  const params = await Promise.resolve(ctx.params);
  const rawId = typeof params?.id === "string" ? params.id : "";
  const id = canonicalProviderId(rawId);

  const checker = new HealthChecker({ providers: routerProviders(owner) });
  const health = await checker.checkProvider(id);
  if (!health) {
    return json({ error: "Provider not found." }, 404);
  }

  return json({ test: health });
}

/** Test-only: reset the probe rate-limit bucket. */
export function _resetProbeBucketForTests(): void {
  probeBucket._clear();
}
