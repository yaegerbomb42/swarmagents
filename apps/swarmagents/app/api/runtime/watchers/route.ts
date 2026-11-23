/**
 * CRUD for ambient watcher rules. Secrets are write-only.
 *
 * GET  /api/runtime/watchers
 * POST /api/runtime/watchers
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import { JsonBodyError, readJsonBody } from "../../../../lib/http";
import { loadRules, upsertRule } from "../../../../lib/ambient/store";
import type { AmbientRule, AmbientTriggerKind } from "../../../../lib/ambient/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = new Set<AmbientTriggerKind>(["cron", "webhook", "file", "github_pr_ci"]);
const TOOL_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function publicRule(rule: AmbientRule) {
  return {
    id: rule.id,
    roleId: rule.roleId,
    prompt: rule.prompt,
    toolAllowlist: rule.toolAllowlist,
    enabled: rule.enabled,
    kind: rule.kind,
    cron: rule.cron,
    timezone: rule.timezone,
    filePath: rule.filePath,
    githubRepo: rule.githubRepo,
    githubPr: rule.githubPr,
    hasSecret: Boolean(rule.webhookSecret),
    delivery: rule.delivery?.url ? { kind: "log" as const, url: rule.delivery.url } : { kind: "log" as const },
  };
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  return NextResponse.json({ rules: loadRules().filter((rule) => rule.userId === user).map(publicRule) });
}

export async function POST(req: NextRequest) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof JsonBodyError && err.status === 413) {
      return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
    }
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  const input = body as Partial<AmbientRule>;
  const id = typeof input.id === "string" ? input.id : "";
  const kind = input.kind;
  const roleId = typeof input.roleId === "string" ? input.roleId : "";
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const allow = Array.isArray(input.toolAllowlist) ? input.toolAllowlist : null;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || !KINDS.has(kind as AmbientTriggerKind) || !roleId || !prompt || !allow) {
    return NextResponse.json({ error: "id, kind, roleId, prompt, and toolAllowlist are required." }, { status: 400 });
  }
  if (allow.length > 64 || allow.some((tool) => typeof tool !== "string" || !TOOL_RE.test(tool))) {
    return NextResponse.json({ error: "toolAllowlist must be exact tool names." }, { status: 400 });
  }
  const rule: AmbientRule = {
    id,
    userId: user,
    roleId,
    prompt: prompt.slice(0, 8000),
    toolAllowlist: allow,
    enabled: input.enabled !== false,
    kind: kind as AmbientTriggerKind,
    cron: typeof input.cron === "string" ? input.cron : undefined,
    timezone: typeof input.timezone === "string" ? input.timezone : undefined,
    webhookSecret: typeof input.webhookSecret === "string" ? input.webhookSecret : undefined,
    filePath: typeof input.filePath === "string" ? input.filePath : undefined,
    githubRepo: typeof input.githubRepo === "string" ? input.githubRepo : undefined,
    githubPr: typeof input.githubPr === "number" ? input.githubPr : undefined,
    delivery: { kind: "log", url: input.delivery?.url },
  };
  if (rule.kind === "webhook" && !rule.webhookSecret) {
    return NextResponse.json({ error: "webhook rules require webhookSecret." }, { status: 400 });
  }
  if (rule.kind === "cron" && !rule.cron) {
    return NextResponse.json({ error: "cron rules require a 5-field cron expression." }, { status: 400 });
  }
  upsertRule(rule);
  return NextResponse.json({ rule: publicRule(rule) });
}
