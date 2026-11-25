import { NextResponse } from "next/server";
import { JsonBodyError, readJsonBody } from "@/lib/http";
import {
  fetchOnlineSkillMd,
  searchOnlineSkills,
  type OnlineSkillSourceId,
} from "@/lib/library/skills-registry";
import { addInstalledItem } from "@/lib/library/user-store";
import { providerOwner } from "@/lib/providers/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

function json(body: unknown, init?: { status?: number }): NextResponse {
  return NextResponse.json(body, { ...init, headers: NO_STORE });
}

function unauthorized() {
  return json({ error: "Sign in required." }, { status: 401 });
}

export async function GET(request: Request) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") ?? "";
  const sourceParam = (searchParams.get("source") ?? "all").toLowerCase();
  const source: OnlineSkillSourceId | "all" =
    sourceParam === "anthropic" || sourceParam === "openai" || sourceParam === "composio"
      ? sourceParam
      : "all";
  const limitRaw = Number(searchParams.get("limit") ?? "30");
  const limit = Number.isFinite(limitRaw) ? limitRaw : 30;
  const offsetRaw = Number(searchParams.get("offset") ?? "0");
  const offset = Number.isFinite(offsetRaw) ? offsetRaw : 0;
  try {
    const result = await searchOnlineSkills(q, { source, limit, offset });
    return json(result);
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : "Could not reach skills registry." },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (err) {
    if (err instanceof JsonBodyError) {
      return json({ error: err.message }, { status: err.status });
    }
    return json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Invalid payload." }, { status: 400 });
  }
  const skillId = typeof (body as Record<string, unknown>).skillId === "string"
    ? String((body as Record<string, unknown>).skillId).trim()
    : "";
  if (!skillId) {
    return json({ error: "skillId is required." }, { status: 400 });
  }

  try {
    const fetched = await fetchOnlineSkillMd(skillId);
    const safeId = fetched.id.replace(/[^a-z0-9._-]+/gi, "-");
    const item = addInstalledItem(owner, {
      id: `skill-${safeId}`,
      kind: "skill",
      name: fetched.name,
      description: fetched.description,
      payload: {
        kind: "skill",
        skillMd: fetched.skillMd,
        files: [],
      },
      secrets: {},
      origin: "public",
    });
    return json({ item }, { status: 201 });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : "Could not install skill." },
      { status: 400 },
    );
  }
}
