/**
 * runs.ts — the browser's client for the run control plane.
 *
 * Every way the workspace starts, stops, resumes or resets a run goes through
 * here, so the request shapes live in one place and are unit-tested against
 * the route contract (app/api/runtime/tasks/route.ts). Nothing in this module
 * touches the DOM; `fetchImpl` is injectable for tests.
 */

import type { ThreadRunInput } from "./thread";

export const TASKS_ENDPOINT = "/api/runtime/tasks";
export const RUNS_ENDPOINT = "/api/runtime/runs";

/** The server caps prompts at 200k chars and agent cards at 4k. */
export const MAX_AGENT_CARD_LEN = 4000;

export type RunTier = "fast" | "balanced" | "deep";

export interface StartRunInput {
  prompt: string;
  /** Continue this harness session. Omit to continue the account's last one. */
  sessionId?: string;
  /** The agent's standing instructions, sent with every run. */
  agentCard?: string;
  /** True: tool calls inside the VM run without asking. False: risky calls wait for approval. */
  fullAuto: boolean;
  /** "cloud" or "computer:<id>". Omit for the account default. */
  computeTarget?: string;
  /** Optional model routing tier intent. */
  tier?: RunTier;
}

export type StartRunResult =
  | { ok: true; runId: string; queued: boolean; position?: number }
  | { ok: false; error: string; status?: number; aborted?: boolean };

export interface ControlResult {
  ok: boolean;
  error?: string;
}

/** The prompt sent when the user attaches files without typing anything. */
export const ATTACHMENTS_ONLY_PROMPT = "(see attachments)";

const UPLOAD_MANIFEST_HEADER = "Uploaded files (in /workspace/uploads/):";

/** One attached file as it appears in the upload manifest. */
export interface UploadManifestEntry {
  path: string;
  size: number;
}

/**
 * Append the upload manifest the agent reads to find attached files. Each
 * line names the exact workspace path and its byte size, so the agent can
 * confirm a file arrived intact before reading it. The conversation strips
 * it back out (see splitUploadedFiles) and shows chips.
 */
export function withUploadManifest(text: string, files: readonly UploadManifestEntry[]): string {
  if (files.length === 0) return text;
  const lines = files.map((file) => `- ${file.path} (${file.size} bytes)`);
  return `${text}\n\n${UPLOAD_MANIFEST_HEADER}\n${lines.join("\n")}`;
}

/** The POST body for a new run. Mirrors the tasks route's accepted fields. */
export function buildRunRequest(input: StartRunInput): Record<string, unknown> {
  const prompt = input.prompt.trim() || ATTACHMENTS_ONLY_PROMPT;
  const agentCard = input.agentCard?.trim().slice(0, MAX_AGENT_CARD_LEN);
  return {
    prompt,
    ...(agentCard ? { agentCard } : {}),
    autoApprove: input.fullAuto,
    fullAuto: input.fullAuto,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.computeTarget ? { computeTarget: input.computeTarget } : {}),
    ...(input.tier ? { tier: input.tier } : {}),
  };
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" && body.error ? body.error : `HTTP ${res.status}`;
}

function networkError(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Network error";
}

function jsonPost(body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  };
}

/** Start (or queue) a run. Never throws: failures come back as `ok: false`. */
export async function startRun(
  input: StartRunInput,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<StartRunResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(TASKS_ENDPOINT, jsonPost(buildRunRequest(input), options.signal));
  } catch (err) {
    if ((err as Error)?.name === "AbortError") return { ok: false, error: "Cancelled before it started.", aborted: true };
    return { ok: false, error: networkError(err) };
  }
  if (!res.ok) return { ok: false, error: await readError(res), status: res.status };
  const body = (await res.json().catch(() => null)) as
    | { runId?: unknown; queued?: unknown; position?: unknown }
    | null;
  if (typeof body?.runId !== "string" || !body.runId) {
    return { ok: false, error: "The server accepted the request but returned no run.", status: res.status };
  }
  return {
    ok: true,
    runId: body.runId,
    queued: body.queued === true,
    ...(typeof body.position === "number" ? { position: body.position } : {}),
  };
}

export type RunsResult = { ok: true; runs: ThreadRunInput[] } | { ok: false; status?: number };

/**
 * The account's runs, newest first. `query` is the route's query string
 * (`limit=20`, `limit=50&sessionId=…`). Never throws; `status` carries the
 * HTTP status of a refusal (401 means signed out).
 */
export async function fetchRuns(
  query: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<RunsResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${RUNS_ENDPOINT}?${query}`, { signal: options.signal, cache: "no-store" });
    if (!res.ok) return { ok: false, status: res.status };
    const body = (await res.json().catch(() => null)) as { runs?: unknown } | null;
    return { ok: true, runs: Array.isArray(body?.runs) ? (body.runs as ThreadRunInput[]) : [] };
  } catch {
    return { ok: false };
  }
}

/** Cancel an active run or remove a queued one. */
export async function stopRun(runId: string, fetchImpl: typeof fetch = fetch): Promise<ControlResult> {
  try {
    const res = await fetchImpl(`${TASKS_ENDPOINT}?runId=${encodeURIComponent(runId)}`, { method: "DELETE" });
    return res.ok ? { ok: true } : { ok: false, error: await readError(res) };
  } catch (err) {
    return { ok: false, error: networkError(err) };
  }
}

async function postAction(body: Record<string, unknown>, fetchImpl: typeof fetch): Promise<ControlResult> {
  try {
    const res = await fetchImpl(TASKS_ENDPOINT, jsonPost(body));
    return res.ok ? { ok: true } : { ok: false, error: await readError(res) };
  } catch (err) {
    return { ok: false, error: networkError(err) };
  }
}

/** Clear the account's persisted session so the next prompt opens a new conversation. */
export function startNewThread(fetchImpl: typeof fetch = fetch): Promise<ControlResult> {
  return postAction({ action: "new_thread" }, fetchImpl);
}

/** Factory-reset the user's VM. */
export function resetVm(fetchImpl: typeof fetch = fetch): Promise<ControlResult> {
  return postAction({ action: "wipe_vm" }, fetchImpl);
}

/** Resume a paused run. The server answers with the run id that continues it. */
export async function resumeRun(runId: string, fetchImpl: typeof fetch = fetch): Promise<StartRunResult> {
  let res: Response;
  try {
    res = await fetchImpl(TASKS_ENDPOINT, jsonPost({ action: "resume", runId }));
  } catch (err) {
    return { ok: false, error: networkError(err) };
  }
  if (!res.ok) return { ok: false, error: await readError(res), status: res.status };
  const body = (await res.json().catch(() => null)) as { runId?: unknown } | null;
  if (typeof body?.runId !== "string" || !body.runId) {
    return { ok: false, error: "The server did not return the resumed run.", status: res.status };
  }
  return { ok: true, runId: body.runId, queued: true };
}
