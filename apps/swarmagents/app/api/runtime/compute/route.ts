/**
 * Compute choices for the composer picker.
 *
 * GET /api/runtime/compute?projectId=<id>
 *   -> {
 *        computers: Computer[],
 *        cloud: { capacity, inUse, full },
 *        freeTier: boolean,
 *        defaultTarget: string,     // "cloud" or "computer:<id>"
 *        projectTarget?: string,    // the project's remembered choice
 *      }
 *
 * The default is cloud unless this is a free-tier account, the cloud VM pool is
 * full, and at least one paired computer is online — then BYOC is the default.
 * A project may remember a target; a target whose computer was revoked is not
 * returned so the picker falls back to the default.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import {
  computeTargetLabel,
  cloudPoolStatus,
  defaultComputeTarget,
  formatComputeTarget,
  isComputeTarget,
  isFreeTier,
  listComputers,
  parseComputeTarget,
} from "../../../../lib/computers";
import { getProject, isProjectId } from "../../../../lib/projects/store";
import { getRuntimeManager } from "../../../../lib/runtime/manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
  }

  const computers = listComputers(user);
  const cloud = cloudPoolStatus(getRuntimeManager().cloudInUse());
  const freeTier = isFreeTier(user);
  const defaultTarget = defaultComputeTarget({ freeTier, poolFull: cloud.full, computers });

  const rawProjectId = req.nextUrl.searchParams.get("projectId");
  let projectTarget: string | undefined;
  if (rawProjectId) {
    if (!isProjectId(rawProjectId)) {
      return NextResponse.json({ error: "Unknown project." }, { status: 404, headers: NO_STORE });
    }
    const project = getProject(user, rawProjectId);
    if (!project) {
      return NextResponse.json({ error: "Unknown project." }, { status: 404, headers: NO_STORE });
    }
    if (project.computeTarget && isComputeTarget(project.computeTarget)) {
      const parsed = parseComputeTarget(project.computeTarget);
      const owned =
        parsed?.kind === "cloud" ||
        (parsed?.kind === "computer" && computers.some((computer) => computer.id === parsed.computerId));
      if (owned) projectTarget = parsed?.kind === "cloud" ? "cloud" : formatComputeTarget(parsed.computerId);
    }
  }

  return NextResponse.json(
    {
      computers,
      cloud,
      freeTier,
      defaultTarget,
      ...(projectTarget ? { projectTarget } : {}),
      defaultLabel: computeTargetLabel(projectTarget ?? defaultTarget, computers),
    },
    { headers: NO_STORE },
  );
}
