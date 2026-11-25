import { NextResponse, type NextRequest } from "next/server";
import { deepHealthSnapshot, healthSnapshot } from "@/lib/health";
import { adminReadinessReport, publicReadinessReport, readinessDetail, readinessSnapshot } from "@/lib/readiness";
import { USER_HEADER, serverMode } from "@/lib/auth";
import { localUserIdForEmail, normalizeEmail } from "@/lib/users";

export const dynamic = "force-dynamic";

/** Same owner default as the provider migration (lib/providers/migrate.ts). */
const DEFAULT_OWNER_EMAIL = "james@swarmagents.codes";

/**
 * Whether the caller may see operator detail. The identity comes from the
 * middleware-set header, which middleware always overwrites so a client
 * cannot forge it. In local mode the machine's own user is the operator; in
 * server mode that is the configured owner account or the server-to-server
 * harness bearer.
 */
function isAdmin(req: NextRequest): boolean {
  const user = (req.headers.get(USER_HEADER) ?? "").trim();
  if (!user) return false;
  if (!serverMode()) return true;
  if (user === "harness") return true;
  const owner = normalizeEmail(process.env.SWARM_OWNER_EMAIL ?? "") || DEFAULT_OWNER_EMAIL;
  return user === localUserIdForEmail(owner);
}

/**
 * Public liveness/readiness probe for deploy checks; see middleware PUBLIC set.
 * - `GET /api/health` — liveness: board writable + version + non-secret
 *   subsystem checks (`vmDriver`, `desktopEnabled`, `catalogConnectorCount`,
 *   `atlasReady`, `toolForgeReady`). `providersConfigured` counts the
 *   signed-in caller's own providers (`providersScope: "user"`), or host
 *   provider env keys when signed out (`providersScope: "host-env"`).
 * - `GET /api/health?ready=1` — readiness: additionally checks the VM driver,
 *   SWARM_HOME writability and free disk; 503 with per-check results on any
 *   failure. Anonymous callers get booleans and stable reason codes only;
 *   paths, byte counts and diagnostics are reserved for an authenticated admin
 *   (and the server log on failure).
 */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("ready") === "1") {
    const report = await readinessSnapshot();
    // Keep the operator detail in the server log even when nobody is signed in.
    if (!report.ready) {
      console.error("[health] readiness failed", JSON.stringify(readinessDetail(report)));
    }
    const body = isAdmin(req) ? adminReadinessReport(report) : publicReadinessReport(report);
    return NextResponse.json(body, {
      status: report.ready ? 200 : 503,
      headers: { "cache-control": "no-store" },
    });
  }
  // Middleware sets the header from the verified session (even on this public
  // route), so a signed-in caller sees a count of their own providers.
  const user = req.headers.get(USER_HEADER);
  const userId = user && user.length <= 128 ? user : null;
  const payload =
    req.nextUrl.searchParams.get("deep") === "1"
      ? deepHealthSnapshot(process.env, userId)
      : healthSnapshot(process.env, userId);
  return NextResponse.json(payload, {
    headers: { "cache-control": "no-store", vary: "cookie" },
  });
}
