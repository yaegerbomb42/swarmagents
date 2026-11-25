/**
 * CRUD for 24/7 scheduled workflows.
 *
 * GET    /api/runtime/schedules            list the caller's schedules
 * POST   /api/runtime/schedules            create one (max 20/user, min 5m cadence)
 * PATCH  /api/runtime/schedules?id=<id>    rename / re-prompt / re-time / pause / resume
 * DELETE /api/runtime/schedules?id=<id>    delete one
 *
 * The webhook secret is returned exactly once, in the create response; every
 * other response carries only `hasWebhookSecret`. All responses are
 * no-store: a cached list would hide a schedule the user just paused.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import { JsonBodyError, readJsonBody } from "../../../../lib/http";
import {
  ScheduleCreateSchema,
  SchedulePatchSchema,
  createSchedule,
  deleteSchedule,
  listSchedules,
  publicSchedule,
  updateSchedule,
} from "../../../../lib/runtime/schedules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Nothing about schedules is cacheable: a cached list would hide a pause. */
const NO_STORE = { "cache-control": "no-store" } as const;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
}

async function readBody(req: NextRequest): Promise<{ ok: true; body: unknown } | { ok: false; res: NextResponse }> {
  try {
    return { ok: true, body: await readJsonBody(req) };
  } catch (err) {
    if (err instanceof JsonBodyError && err.status === 413) {
      return { ok: false, res: NextResponse.json({ error: "Request body is too large." }, { status: 413, headers: NO_STORE }) };
    }
    return { ok: false, res: NextResponse.json({ error: "Invalid JSON." }, { status: 400, headers: NO_STORE }) };
  }
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();
  return NextResponse.json(
    { schedules: listSchedules(user).map(publicSchedule) },
    { headers: NO_STORE },
  );
}

export async function POST(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();
  const read = await readBody(req);
  if (!read.ok) return read.res;
  const parsed = ScheduleCreateSchema.safeParse(read.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid schedule." },
      { status: 400, headers: NO_STORE },
    );
  }
  try {
    const schedule = createSchedule(user, parsed.data);
    // The webhook secret is shown exactly once, here. Later reads never
    // include it (see publicSchedule).
    return NextResponse.json(
      { schedule: publicSchedule(schedule), webhookSecret: schedule.webhookSecret },
      { status: 201, headers: NO_STORE },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create schedule." },
      { status: 400, headers: NO_STORE },
    );
  }
}

export async function PATCH(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id) {
    return NextResponse.json({ error: "id is required." }, { status: 400, headers: NO_STORE });
  }
  const read = await readBody(req);
  if (!read.ok) return read.res;
  const parsed = SchedulePatchSchema.safeParse(read.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid schedule update." },
      { status: 400, headers: NO_STORE },
    );
  }
  try {
    const schedule = updateSchedule(user, id, parsed.data);
    if (!schedule) {
      return NextResponse.json({ error: "Schedule not found." }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json({ schedule: publicSchedule(schedule) }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update schedule." },
      { status: 400, headers: NO_STORE },
    );
  }
}

export async function DELETE(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id) {
    return NextResponse.json({ error: "id is required." }, { status: 400, headers: NO_STORE });
  }
  if (!deleteSchedule(user, id)) {
    return NextResponse.json({ error: "Schedule not found." }, { status: 404, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
