/**
 * Output lenses — re-read an agent message through a lens.
 *
 * POST /api/lenses
 *   body: { runId?: string, lens: "eli5"|"executive"|"code-review"|"security"|"architecture",
 *           message: string, files?: {path: string, content: string}[] }
 *   -> { lens, text, provider, model, costUsd, latencyMs, cached, createdAt }
 *
 * The caller is the signed-in user (x-swarm-user). When a runId is given the
 * run must belong to that user — the referenced files are then taken from
 * that run's report (the files the agent created or modified), capped so a
 * lens never ships a whole workspace to a model.
 *
 * The answer runs on the cheapest capable model of the user's own providers
 * and is cached per (message, lens, run, files) in the user's own store.
 */

import { type NextRequest } from "next/server";
import { USER_HEADER } from "../../../lib/auth";
import { noStoreJson, readJsonObject } from "../../../lib/http";
import { lensErrorResponse } from "../../../lib/lenses/error-response";
import { isLensId, type LensId } from "../../../lib/lenses/types";
import { cachedLens, runLens } from "../../../lib/lenses/run";
import { MAX_FILES, type ReferencedFile } from "../../../lib/lenses/prompts";
import { AbortError, RouterError } from "../../../lib/providers/errors";
import { TokenBucket } from "../../../lib/rate-limit";
import { getRun } from "../../../lib/runtime/run-store";
import { RUN_ID_RE } from "../../../lib/telemetry/paths";
import { collectRunArtifactFiles } from "../../../lib/lenses/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 256 * 1024;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_FILE_CONTENT_CHARS = 8_000;

function perMinute(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Lens calls cost money, so they get their own per-user budget. Cached
 * answers from a plain (no-run) request are free and never reach this bucket;
 * run-backed requests consume up front so the VM artifact reads are gated.
 */
const lensBucket = new TokenBucket(perMinute("SWARM_LENS_RATE_LIMIT_PER_MIN", 20), 60_000);

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFiles(value: unknown): ReferencedFile[] {
  if (!Array.isArray(value)) return [];
  const files: ReferencedFile[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const path = typeof entry.path === "string" ? entry.path.slice(0, 256) : "";
    const content = typeof entry.content === "string" ? entry.content.slice(0, MAX_FILE_CONTENT_CHARS) : "";
    if (!path || !content.trim()) continue;
    files.push({ path, content });
    if (files.length >= MAX_FILES) break;
  }
  return files;
}

export async function POST(req: NextRequest) {
  const user = caller(req);
  if (!user) return noStoreJson({ error: "Sign in required." }, { status: 401 });

  // Bounded, streaming body read: an oversized body is rejected with 413
  // before it is buffered; a malformed body or a non-object stays a 400.
  const parsed = await readJsonObject(req, MAX_BODY_SIZE);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;

  if (!isLensId(body.lens)) {
    return noStoreJson({ error: "Unknown lens." }, { status: 400 });
  }
  const lens: LensId = body.lens;

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return noStoreJson({ error: "A message is required." }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return noStoreJson({ error: "Message too long." }, { status: 400 });
  }

  const runId = typeof body.runId === "string" && body.runId ? body.runId : undefined;
  if (runId !== undefined && !RUN_ID_RE.test(runId)) {
    return noStoreJson({ error: "Invalid run id." }, { status: 400 });
  }
  if (runId !== undefined) {
    const run = getRun(runId);
    // A run without an owner is not visible to anybody; another user's run
    // must look like it does not exist.
    if (!run || run.summary.userId !== user) {
      return noStoreJson({ error: "Run not found." }, { status: 404 });
    }
  }

  const clientFiles = parseFiles(body.files);

  // When a run is referenced, the VM artifact reads below are the expensive,
  // protected operation: consume the rate limit BEFORE touching the VM so an
  // exhausted caller cannot force disk reads just to be refused.
  if (runId !== undefined) {
    const rate = lensBucket.consume(`lens:${user}`);
    if (!rate.allowed) {
      return noStoreJson(
        { error: "Too many lens requests — try again in a moment." },
        { status: 429, headers: { "Retry-After": String(rate.retryAfter) } },
      );
    }
  }

  const runFiles = runId ? await collectRunArtifactFiles(user, runId) : [];
  const files = [...runFiles, ...clientFiles].slice(0, MAX_FILES);

  // A cached answer is free: it never touches the rate limit or a provider.
  // The files were resolved above, so the lookup is keyed on the same
  // (message, run, files) the lens would run on.
  const cached = cachedLens(user, message, lens, { runId, files });
  if (cached) return noStoreJson(cached);

  // Without a run there are no VM reads to protect, so the rate check can stay
  // on the uncached path — cached answers stay free for those callers.
  if (runId === undefined) {
    const rate = lensBucket.consume(`lens:${user}`);
    if (!rate.allowed) {
      return noStoreJson(
        { error: "Too many lens requests — try again in a moment." },
        { status: 429, headers: { "Retry-After": String(rate.retryAfter) } },
      );
    }
  }

  try {
    const result = await runLens({
      userId: user,
      lens,
      message,
      files,
      ...(runId ? { runId } : {}),
      signal: req.signal,
    });
    return noStoreJson(result);
  } catch (err) {
    // A cancelled request is a client-side abort, not a provider failure.
    if (
      req.signal.aborted ||
      err instanceof AbortError ||
      (err instanceof RouterError && err.code === "aborted")
    ) {
      return noStoreJson({ error: "Request aborted." }, { status: 499 });
    }
    // RouterError messages are already redacted (no key material), so the
    // provider's own wording is safe to surface via the shared helper.
    // Anything else is an internal failure — its message can carry
    // filesystem paths or stack fragments, so it never reaches the client.
    if (err instanceof RouterError) {
      return lensErrorResponse(err);
    }
    return noStoreJson({ error: "Lens failed." }, { status: 500 });
  }
}
