import { NextResponse } from "next/server";
import { providerOwner } from "@/lib/providers/owner";
import { getHealthChecker } from "@/lib/providers/health-pool";

export const dynamic = "force-dynamic";

/**
 * How long the first response waits for the initial probe round before
 * falling back to `checking` entries. One probe timeout plus headroom; the
 * background round keeps running and later calls return real results.
 */
const FIRST_CHECK_TIMEOUT_MS = 12_000;

/**
 * Returns per-provider health status and latency for the signed-in user's
 * providers, without exposing keys. Status is derived from lightweight ping
 * checks using the fastest model tier. The first call awaits the initial
 * probe round, so it covers every configured provider; if a probe stalls,
 * that provider is reported as `checking` instead of being omitted.
 * Passing `?refresh=1` forces an immediate probe round.
 */
export async function GET(request: Request) {
  const owner = providerOwner(request);
  if (!owner) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh") === "1";
  const checker = getHealthChecker(owner);

  if (refresh) {
    await checker.checkAll();
  } else {
    await Promise.race([
      checker.ensureChecked(),
      new Promise((resolve) => setTimeout(resolve, FIRST_CHECK_TIMEOUT_MS)),
    ]);
  }

  return NextResponse.json(
    { providers: checker.fullSnapshot() },
    { headers: { "cache-control": "no-store" } }
  );
}
