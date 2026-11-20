/**
 * Token-count estimate for the Anthropic Messages API
 * (POST /api/runtime/llm/<runToken>/v1/messages/count_tokens).
 *
 * The provider's real tokenizer is not exposed through the bridge, so this
 * returns the same heuristic estimate the system uses internally (see
 * lib/providers/anthropic-bridge.ts estimateInputTokens). Auth and rate
 * limits are shared with the messages endpoint.
 */

import { type NextRequest, NextResponse } from "next/server";
import { estimateInputTokens } from "../../../../../../../../lib/providers/anthropic-bridge";
import { authLlmCall, checkLlmRateLimit, MAX_LLM_BODY_BYTES } from "../../../../../../../../lib/runtime/llm-shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ runToken: string }> }) {
  const { runToken } = await ctx.params;

  const caller = authLlmCall(req, runToken);
  if (caller instanceof Response) return caller;

  const limited = checkLlmRateLimit(caller.owner);
  if (limited) return limited;

  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ type: "error", error: { type: "invalid_request_error", message: "Could not read request body." } }, { status: 400 });
  }
  if (Buffer.byteLength(text, "utf8") > MAX_LLM_BODY_BYTES) {
    return NextResponse.json({ type: "error", error: { type: "invalid_request_error", message: "Request body too large." } }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body." } }, { status: 400 });
  }

  return NextResponse.json({ input_tokens: estimateInputTokens(body) });
}
