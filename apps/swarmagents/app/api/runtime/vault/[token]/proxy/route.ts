/**
 * POST /api/runtime/vault/<token>/proxy
 * VM-facing hop. The token in the path is the only credential the VM holds.
 */

import { NextResponse, type NextRequest } from "next/server";
import { JsonBodyError, readJsonBody } from "../../../../../../lib/http";
import { proxyVaultRequest } from "../../../../../../lib/secrets/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  let parsed: {
    secretId?: unknown;
    url?: unknown;
    method?: unknown;
    headers?: unknown;
    body?: unknown;
  };
  try {
    parsed = (await readJsonBody(req)) as typeof parsed;
  } catch (err) {
    if (err instanceof JsonBodyError && err.status === 413) {
      return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
    }
    return NextResponse.json({ error: "JSON body required." }, { status: 400 });
  }
  if (typeof parsed.secretId !== "string" || typeof parsed.url !== "string") {
    return NextResponse.json({ error: "secretId and url are required." }, { status: 400 });
  }
  const headers: Record<string, string> = {};
  if (parsed.headers && typeof parsed.headers === "object" && !Array.isArray(parsed.headers)) {
    for (const [k, v] of Object.entries(parsed.headers as Record<string, unknown>)) {
      if (typeof v === "string") headers[k] = v;
    }
  }
  const result = await proxyVaultRequest({
    token,
    secretId: parsed.secretId,
    url: parsed.url,
    method: typeof parsed.method === "string" ? parsed.method : undefined,
    headers,
    body: typeof parsed.body === "string" ? parsed.body : undefined,
  });
  return new NextResponse(result.body, { status: result.status, headers: result.headers });
}
