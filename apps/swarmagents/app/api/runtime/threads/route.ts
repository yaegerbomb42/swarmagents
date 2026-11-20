/**
 * Thread history. Groups the caller's durable runs by harness sessionId so
 * the UI can list threads (title, time, run count) and reopen any of them.
 *
 * GET /api/runtime/threads?limit=20&projectId=<id>
 *   -> {threads: ThreadSummary[]}
 * Threads are scoped to the caller and returned newest-activity-first.
 * ?limit defaults to 20 (max 50). ?projectId narrows the list to one of the
 * caller's projects (g5); an id that is not theirs is a 404, never a leak.
 * Only threads among the caller's 100 most recent runs are listed (see
 * THREAD_SOURCE_LIMIT in run-store).
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import { getProject, isProjectId } from "../../../../lib/projects/store";
import { listThreads } from "../../../../lib/runtime/run-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const rawLimit = req.nextUrl.searchParams.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (!Number.isSafeInteger(n) || n <= 0) {
      return NextResponse.json({ error: "limit must be a positive integer" }, { status: 400 });
    }
    limit = Math.min(n, MAX_LIMIT);
  }

  const rawProject = req.nextUrl.searchParams.get("projectId");
  let projectId: string | undefined;
  if (rawProject !== null) {
    if (!isProjectId(rawProject)) {
      return NextResponse.json({ error: "Unknown project." }, { status: 404 });
    }
    if (!getProject(user, rawProject)) {
      return NextResponse.json({ error: "Unknown project." }, { status: 404 });
    }
    projectId = rawProject;
  }

  const threads = listThreads({ userId: user, limit: limit ?? DEFAULT_LIMIT, projectId });
  return NextResponse.json({ threads });
}
