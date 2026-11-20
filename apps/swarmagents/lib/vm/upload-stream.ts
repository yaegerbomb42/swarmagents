// Streaming multipart parser for the VM upload route.
//
// `Request.formData()` buffers the entire body before any limit can be
// applied, which lets a chunked request (no Content-Length) stream an
// unbounded amount of data into the server's memory. This parser instead
// consumes `request.body` incrementally:
//
//  - every part is written to a 0600 temp file under a private temp dir, so
//    live memory stays bounded by one network chunk;
//  - a single file may not exceed `maxFileBytes` — the read is aborted with a
//    413 as soon as the cap is crossed, before the rest of the body arrives;
//  - the whole body may not exceed `maxRequestBytes` (missing or invalid
//    Content-Length is treated as unbounded and caught here);
//  - the temp dir is removed on success, on every error, and when the caller
//    calls dispose().
//
// Only field name "files" with a filename becomes an upload; other fields
// are drained and discarded (bounded by maxFieldBytes).

import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Limits applied while the body is streamed. */
export interface UploadStreamLimits {
  /** Max number of file parts per request. */
  maxFiles: number;
  /** Max bytes per file part (enforced while streaming). */
  maxFileBytes: number;
  /** Max bytes for the whole request body (enforced while streaming). */
  maxRequestBytes: number;
  /** Max bytes for a non-file field value (default 64 KiB). */
  maxFieldBytes?: number;
  /** Max bytes of one part's headers (default 16 KiB). */
  maxHeaderBytes?: number;
}

/** One streamed file part, already persisted to a temp file. */
export interface StreamedUploadFile {
  name: string;
  type: string;
  size: number;
  /** Host temp file holding the bytes; removed by dispose(). */
  tempPath: string;
}

export interface ParsedMultipartUpload {
  files: StreamedUploadFile[];
  /** Raw request-body bytes consumed. */
  totalBytes: number;
  /** Remove the temp directory. Idempotent. */
  dispose: () => Promise<void>;
}

/** Typed parse/limit error; routes map it to a status + error code. */
export class UploadStreamError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = "UploadStreamError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const CRLF = Buffer.from("\r\n");
const CRLFCRLF = Buffer.from("\r\n\r\n");
const DEFAULT_MAX_FIELD_BYTES = 64 * 1024;
const DEFAULT_MAX_HEADER_BYTES = 16 * 1024;
const MAX_BOUNDARY_LENGTH = 70;

/**
 * Extract the multipart boundary from a Content-Type header. Returns null for
 * a non-multipart type or a missing/invalid boundary.
 */
export function multipartBoundary(contentType: string | null): string | null {
  if (!contentType || !/^multipart\/form-data\b/i.test(contentType)) return null;
  const match = /;\s*boundary=(?:"([^"]{1,70})"|([^;\s]{1,70}))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.length > MAX_BOUNDARY_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(boundary)) return null;
  return boundary;
}

/** Decode one Content-Disposition parameter (quoted or unquoted). */
function dispositionParam(header: string, key: string): string | undefined {
  const quoted = new RegExp(`(?:^|;)\\s*${key}="((?:\\\\.|[^"\\\\])*)"`, "i").exec(header);
  // Only unescape quoted-pairs that represent a literal quote or backslash.
  // Any other backslash (e.g. a Windows path from a hand-built client) is
  // preserved so the filename validator can reject it.
  if (quoted) return quoted[1].replace(/\\(["\\])/g, "$1");
  const plain = new RegExp(`(?:^|;)\\s*${key}=([^;\\s]+)`, "i").exec(header);
  return plain?.[1];
}

/** Decode an RFC 5987 `filename*=UTF-8''...` parameter. */
function extendedFilename(header: string): string | undefined {
  const match = /(?:^|;)\s*filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[2]);
  } catch {
    return undefined;
  }
}

/**
 * Undici (and browsers) escape the few characters that cannot appear in a
 * quoted multipart filename: `"`, CR and LF. Decode only those, so a literal
 * "%" or "%20" in a real filename survives untouched.
 */
function unescapeFilename(name: string): string {
  return name
    .replace(/%22/gi, '"')
    .replace(/%0d/gi, "\r")
    .replace(/%0a/gi, "\n");
}

interface PartHeaders {
  name: string;
  filename: string | undefined;
  type: string;
}

function parsePartHeaders(text: string): PartHeaders {
  let disposition = "";
  let type = "";
  for (const line of text.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "content-disposition") disposition = value;
    else if (key === "content-type") type = value;
  }
  return {
    name: dispositionParam(disposition, "name") ?? "",
    filename: (() => {
      const raw = extendedFilename(disposition) ?? dispositionParam(disposition, "filename");
      return raw === undefined ? undefined : unescapeFilename(raw);
    })(),
    type: type || "application/octet-stream",
  };
}

/**
 * Stream-parse a multipart/form-data request into temp files.
 *
 * @throws UploadStreamError for malformed input or a crossed limit.
 */
export async function parseMultipartUpload(
  req: Request,
  limits: UploadStreamLimits,
): Promise<ParsedMultipartUpload> {
  const boundary = multipartBoundary(req.headers.get("content-type"));
  if (!boundary) {
    throw new UploadStreamError(400, "bad_request", "Expected a multipart/form-data body.");
  }
  const body = req.body;
  if (!body) {
    throw new UploadStreamError(400, "no_files", "No files were attached.");
  }

  const maxFieldBytes = limits.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES;
  const maxHeaderBytes = limits.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
  const tempDir = await mkdtemp(path.join(tmpdir(), "swarm-upload-"));
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  };

  const reader = body.getReader();
  let pending = Buffer.alloc(0);
  let streamEnded = false;
  let totalBytes = 0;
  let cancelled = false;

  const cancel = async (): Promise<void> => {
    if (cancelled || streamEnded) return;
    cancelled = true;
    await reader.cancel().catch(() => {});
  };

  const readMore = async (): Promise<boolean> => {
    if (streamEnded) return false;
    const { value, done } = await reader.read();
    if (done) {
      streamEnded = true;
      return false;
    }
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > limits.maxRequestBytes) {
        await cancel();
        throw new UploadStreamError(
          413,
          "body_too_large",
          `Upload body exceeds the ${limits.maxRequestBytes} byte limit.`,
          { limit: limits.maxRequestBytes },
        );
      }
      const chunk = Buffer.from(value);
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    }
    return true;
  };

  const delimiter = Buffer.from(`--${boundary}`);
  const bodyDelimiter = Buffer.from(`\r\n--${boundary}`);

  /** Consume the CRLF or "--" that follows a boundary line. */
  const afterBoundary = async (): Promise<"part" | "end"> => {
    while (pending.length < 2) {
      if (!(await readMore())) {
        throw new UploadStreamError(400, "bad_request", "Truncated multipart body.");
      }
    }
    if (pending[0] === 0x2d && pending[1] === 0x2d) {
      pending = pending.subarray(2);
      return "end";
    }
    if (pending[0] === 0x0d && pending[1] === 0x0a) {
      pending = pending.subarray(2);
      return "part";
    }
    throw new UploadStreamError(400, "bad_request", "Malformed multipart boundary.");
  };

  /**
   * Read bytes until the CRLF--boundary that ends this part, forwarding each
   * chunk to onData. Returns whether another part follows.
   */
  const readPartBody = async (onData: (chunk: Buffer) => Promise<void>): Promise<"part" | "end"> => {
    for (;;) {
      const index = pending.indexOf(bodyDelimiter);
      if (index >= 0) {
        if (index > 0) await onData(pending.subarray(0, index));
        pending = pending.subarray(index + bodyDelimiter.length);
        return afterBoundary();
      }
      // Keep enough tail to match a delimiter split across chunks.
      const keep = bodyDelimiter.length - 1;
      if (pending.length > keep) {
        const flushEnd = pending.length - keep;
        await onData(pending.subarray(0, flushEnd));
        pending = pending.subarray(flushEnd);
      }
      if (!(await readMore())) {
        throw new UploadStreamError(400, "bad_request", "Truncated multipart body.");
      }
    }
  };

  const files: StreamedUploadFile[] = [];

  try {
    // Skip any preamble and find the first boundary.
    for (;;) {
      const index = pending.indexOf(delimiter);
      if (index >= 0) {
        pending = pending.subarray(index + delimiter.length);
        break;
      }
      const keep = delimiter.length - 1;
      if (pending.length > keep) pending = pending.subarray(pending.length - keep);
      if (!(await readMore())) {
        throw new UploadStreamError(400, "bad_request", "Malformed multipart body.");
      }
    }

    let state = await afterBoundary();
    while (state === "part") {
      let separator: number;
      while ((separator = pending.indexOf(CRLFCRLF)) < 0) {
        if (pending.length > maxHeaderBytes) {
          throw new UploadStreamError(400, "bad_request", "Multipart headers are too large.");
        }
        if (!(await readMore())) {
          throw new UploadStreamError(400, "bad_request", "Truncated multipart body.");
        }
      }
      const headers = parsePartHeaders(pending.subarray(0, separator).toString("utf8"));
      pending = pending.subarray(separator + CRLFCRLF.length);

      const isFile = headers.filename !== undefined && headers.name === "files";
      if (isFile) {
        if (files.length >= limits.maxFiles) {
          await cancel();
          throw new UploadStreamError(
            400,
            "too_many_files",
            `Too many files: at most ${limits.maxFiles} per message.`,
            { limit: limits.maxFiles },
          );
        }
        const tempPath = path.join(tempDir, `part-${files.length}.bin`);
        const handle = await open(tempPath, "wx", 0o600);
        let size = 0;
        try {
          state = await readPartBody(async (chunk) => {
            size += chunk.length;
            if (size > limits.maxFileBytes) {
              await cancel();
              throw new UploadStreamError(
                413,
                "file_too_large",
                `"${headers.filename}" is larger than ${limits.maxFileBytes} bytes.`,
                { name: headers.filename, limit: limits.maxFileBytes },
              );
            }
            await handle.write(chunk);
          });
        } finally {
          await handle.close().catch(() => {});
        }
        files.push({
          name: headers.filename as string,
          type: headers.type,
          size,
          tempPath,
        });
      } else {
        let fieldBytes = 0;
        state = await readPartBody(async (chunk) => {
          fieldBytes += chunk.length;
          if (fieldBytes > maxFieldBytes) {
            await cancel();
            throw new UploadStreamError(400, "bad_request", "A form field is too large.");
          }
        });
      }
    }

    // The epilogue (if any) is irrelevant; release the stream.
    await cancel();
    return { files, totalBytes, dispose };
  } catch (err) {
    await cancel();
    await dispose();
    throw err;
  }
}
