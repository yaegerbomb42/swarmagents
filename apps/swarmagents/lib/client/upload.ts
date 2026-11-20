/**
 * Client helpers for chat attachments (InputBar -> task prompt).
 *
 * Attachments are uploaded with a single multipart POST to
 * /api/runtime/vm/files/upload; the server writes each file into the caller's
 * own VM workspace under /workspace/uploads/ and returns the absolute paths.
 * The UI then appends those paths to the prompt so the agent knows where the
 * files live. The same limits the server enforces are validated here first so
 * rejects surface inline in the input bar instead of as a failed request.
 */

// The limits are shared with the upload route so client and server never
// disagree about what is acceptable (see lib/vm/files.ts).
import { MAX_UPLOAD_FILE_BYTES, MAX_UPLOAD_FILES } from "../vm/files";
export { MAX_UPLOAD_FILE_BYTES, MAX_UPLOAD_FILES };

/** The upload endpoint, relative to the app origin. */
export const UPLOAD_ENDPOINT = "/api/runtime/vm/files/upload";

/** Minimal file shape the uploader needs (a DOM File satisfies it). */
export interface PendingAttachment {
  name: string;
  size: number;
  type: string;
  file: File | Blob;
}

/** One stored upload, as reported by the route. */
export interface UploadedFile {
  name: string;
  path: string;
  size: number;
  type: string;
}

export interface UploadResult {
  uploadDir: string;
  uploaded: UploadedFile[];
}

/** Typed failure from the upload API (network, auth, limits, VM writes). */
export class UploadError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, extra?: { status?: number; code?: string }) {
    super(message);
    this.name = "UploadError";
    this.status = extra?.status;
    this.code = extra?.code;
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Client-side check for one attachment, matching the server's limits.
 * Returns an inline error message, or null when the file is acceptable.
 */
export function validateAttachment(candidate: { name: string; size: number }, currentCount: number): string | null {
  if (currentCount >= MAX_UPLOAD_FILES) {
    return `Maximum ${MAX_UPLOAD_FILES} files per message.`;
  }
  if (candidate.size > MAX_UPLOAD_FILE_BYTES) {
    return `"${candidate.name}" is larger than 10 MB.`;
  }
  return null;
}

export type FetchLike = typeof fetch;

export interface UploadRequestOptions {
  signal?: AbortSignal;
  /** Injectable fetch for tests. */
  fetchImpl?: FetchLike;
}

/**
 * Upload attachments into the user's VM workspace and return the stored
 * paths. Throws UploadError on any failure; aborts propagate as-is.
 */
export async function uploadAttachments(
  atts: PendingAttachment[],
  options: UploadRequestOptions = {},
): Promise<UploadResult> {
  const form = new FormData();
  for (const a of atts) form.append("files", a.file, a.name);
  const fetchImpl = options.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(UPLOAD_ENDPOINT, {
      method: "POST",
      body: form,
      signal: options.signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new UploadError("Could not reach the upload API.", { code: "network" });
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    const message =
      typeof obj?.error === "string" ? obj.error : `Upload failed (HTTP ${res.status}).`;
    const code = typeof obj?.code === "string" ? obj.code : undefined;
    throw new UploadError(message, { status: res.status, code });
  }

  const result = body as UploadResult;
  if (!result || !Array.isArray(result.uploaded)) {
    throw new UploadError("The upload API returned an unexpected response.", { code: "malformed" });
  }
  return result;
}
