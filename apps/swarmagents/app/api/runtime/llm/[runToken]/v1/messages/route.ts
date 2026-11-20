/**
 * Server-side LLM translation endpoint for Claude Code inside a user's VM.
 *
 * POST /api/runtime/llm/<runToken>/v1/messages
 *
 * The VM's Claude Code speaks the Anthropic Messages API and is pointed at
 * this endpoint (ANTHROPIC_BASE_URL). It authenticates with the per-run
 * token (ANTHROPIC_AUTH_TOKEN). The server forwards the request to the run
 * owner's ranked providers: raw pass-through for anthropic-format providers,
 * translated to /v1/chat/completions for openai-format providers, failing
 * over by rank on 404/429/5xx/connect errors. The provider's real key never
 * leaves the server.
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  anthropicErrorBody,
  BridgeValidationError,
} from "../../../../../../../lib/providers/anthropic-bridge";
import { forwardLlmNonStreaming, forwardLlmStreaming, type LlmFailure } from "../../../../../../../lib/runtime/llm-gateway";
import { authLlmCall, checkLlmRateLimit, MAX_LLM_BODY_BYTES } from "../../../../../../../lib/runtime/llm-shared";
import { getRuntimeManager } from "../../../../../../../lib/runtime/manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failureResponse(failure: LlmFailure): NextResponse {
  return new NextResponse(failure.body, {
    status: failure.status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ runToken: string }> }) {
  const { runToken } = await ctx.params;

  // Auth before reading the body so unauthenticated calls are cheap.
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
  if (!isRecord(body) || !Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json({ type: "error", error: { type: "invalid_request_error", message: "messages must be a non-empty array." } }, { status: 400 });
  }

  const streaming = body.stream === true;
  const requestedModel = typeof body.model === "string" ? body.model : undefined;
  const owner = caller.owner;
  const router = getRuntimeManager().routerForUser(owner);
  if (!router) {
    return failureResponse({ status: 503, body: anthropicErrorBody(503, "No LLM providers are configured for this account."), attempts: [] });
  }

  try {
    const providers = router.providerConfigs();
    if (!streaming) {
      const result = await forwardLlmNonStreaming({
        owner,
        providers,
        body,
        requestedModel,
        signal: req.signal,
        runId: caller.runId,
      });
      const ok = [...result.attempts].reverse().find((a) => a.ok);
      const res = NextResponse.json(result.body);
      if (ok) res.headers.set("x-swarm-provider", ok.provider);
      return res;
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const chunk of forwardLlmStreaming({
            owner,
            providers,
            body,
            requestedModel,
            signal: req.signal,
            runId: caller.runId,
          })) {
            controller.enqueue(chunk);
          }
          controller.close();
        } catch (err) {
          const failure = err as LlmFailure;
          const res = failure && typeof failure === "object" && "body" in failure
            ? failure.body
            : anthropicErrorBody(502, "LLM proxy stream failed.");
          try {
            controller.enqueue(encoder.encode(`event: error\ndata: ${res}\n\n`));
          } catch {
            // The client may have disconnected; nothing else to do.
          }
          controller.close();
        }
      },
      cancel() {
        // Client went away; the upstream fetch is aborted via req.signal.
      },
    });

    const res = new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "connection": "keep-alive",
        "x-accel-buffering": "no",
      },
    });
    return res;
  } catch (err) {
    if (err instanceof BridgeValidationError) {
      return NextResponse.json({ type: "error", error: { type: "invalid_request_error", message: err.message } }, { status: 400 });
    }
    const failure = err as LlmFailure;
    if (failure && typeof failure === "object" && "status" in failure && typeof failure.status === "number") {
      return failureResponse(failure);
    }
    return NextResponse.json({ type: "error", error: { type: "api_error", message: "LLM proxy failed." } }, { status: 502 });
  }
}
