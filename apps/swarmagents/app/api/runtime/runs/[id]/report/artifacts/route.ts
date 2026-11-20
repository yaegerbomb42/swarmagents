/**
 * Artifact download from a run's report (owner-only).
 *
 * GET /api/runtime/runs/<id>/report/artifacts?path=<rel path> -> file bytes
 *
 * Only files that appear in the report's artifact list (created/modified by
 * the agent under /workspace during the run) can be downloaded, and only by
 * the run's owner. The file is streamed live from the user's VM workspace.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../../../lib/auth";
import { RUN_ID_RE } from "../../../../../../../lib/telemetry/paths";
import { getRun } from "../../../../../../../lib/runtime/run-store";
import { readRunReport, MAX_ARTIFACT_DOWNLOAD_BYTES } from "../../../../../../../lib/runtime/run-report";
import { getVmManager } from "../../../../../../../lib/vm/manager";
import { resolveWorkspacePath, VmPathError } from "../../../../../../../lib/vm/files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fileNameFromPath(filePath: string): string {
  const base = filePath.split("/").pop() ?? "artifact";
  return base.replace(/[^\w.-]+/g, "_") || "artifact";
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = req.headers.get(USER_HEADER);
  if (!user || user.length > 128) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const { id } = await ctx.params;
  if (!RUN_ID_RE.test(id)) return NextResponse.json({ error: "invalid runId" }, { status: 400 });

  const report = readRunReport(id);
  if (!report) return NextResponse.json({ error: "Run report not found." }, { status: 404 });
  const owner = report.userId || getRun(id)?.summary.userId;
  if (!owner || owner !== user) {
    return NextResponse.json({ error: "Run report not found." }, { status: 404 });
  }

  const rawPath = req.nextUrl.searchParams.get("path");
  let absPath: string;
  try {
    absPath = resolveWorkspacePath(rawPath);
  } catch {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 });
  }

  // Only files the report lists as artifacts (created/modified during the run)
  // are downloadable.
  const artifact = report.artifacts.find((entry) => entry.path === absPath);
  if (!artifact) {
    return NextResponse.json({ error: "File is not an artifact of this run." }, { status: 404 });
  }

  const vm = getVmManager();
  let file;
  try {
    file = await vm.readFileBytes(user, absPath, MAX_ARTIFACT_DOWNLOAD_BYTES);
  } catch (err) {
    if (err instanceof VmPathError) {
      // The report lists a workspace path that is (now) a symlink pointing
      // outside /workspace — refuse instead of serving e.g. /proc/1/environ.
      return NextResponse.json({ error: "Artifact is outside the workspace." }, { status: 403 });
    }
    return NextResponse.json({ error: "Could not read file from the VM." }, { status: 404 });
  }

  return new Response(Uint8Array.from(file.content), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fileNameFromPath(absPath)}"`,
      "Content-Length": String(file.content.byteLength),
      "Cache-Control": "private, max-age=60",
    },
  });
}
