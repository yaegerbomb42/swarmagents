/**
 * VM file upload API.
 *
 * POST /api/runtime/vm/files/upload  (multipart/form-data, field "files")
 *   -> { uploadDir, uploaded: [{ name, path, size, type }] }
 *
 * Uploads bypass middleware (it buffers bodies with a size cap), so this
 * route gates itself: the host allowlist (loopback in local mode,
 * SWARM_ALLOWED_HOSTS in server mode) applies in every mode, then the
 * server-mode rate limit, then authentication (signed session cookie or
 * harness bearer). See lib/auth. Both modes reject browser requests from a
 * different origin. Every file is written into the caller's own
 * VM workspace under
 * /workspace/uploads/ via the VM manager's file APIs (writeFile for text,
 * base64-decode exec for binary bytes), with filenames sanitized and the
 * destination resolved through the lib/vm/files traversal guard and the
 * driver's in-VM realpath check before any driver call.
 *
 * The multipart body is parsed as a stream (lib/vm/upload-stream), never via
 * `formData()`: a chunked request with no Content-Length cannot make the
 * server buffer an unbounded body, the per-file cap is enforced while the
 * bytes arrive, and a crossed cap aborts the read with 413. Concurrent
 * uploads are bounded per process.
 *
 * Limits are enforced server-side: at most MAX_UPLOAD_FILES files per
 * request, each at most MAX_UPLOAD_FILE_BYTES. Violations fail the whole
 * request before anything is written, so a rejected upload never leaves
 * partial files behind. Every write also checks the workspace disk quota
 * (VM-05), with the incoming bytes counted against the remaining headroom.
 * Successful uploads append one audit entry.
 */

import { readFile as readTempFile } from "node:fs/promises";
import { NextResponse, type NextRequest } from "next/server";
import { hostAllowed, isHarnessBearer, requestUser, serverMode } from "../../../../../../lib/auth";
import { isCrossSite } from "../../../../../../lib/request-policy";
import { rateLimitCheck, rateLimitKey, rateLimitResponse } from "../../../../../../lib/rate-limit";
import { getVmManager } from "../../../../../../lib/vm/manager";
import {
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_FILES,
  UPLOAD_DIR,
  looksBinary,
  resolveWorkspacePath,
  VmFileError,
  VmPathError,
} from "../../../../../../lib/vm/files";
import { isKnownStreamError } from "../../../../../../lib/vm/stream-errors";
import {
  parseMultipartUpload,
  UploadStreamError,
  type StreamedUploadFile,
} from "../../../../../../lib/vm/upload-stream";
import { QuotaError } from "../../../../../../lib/vm/quotas";
import { recordAudit } from "../../../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Upper bound for the whole multipart body: the per-file caps plus 1 MiB of
 * framing overhead. The declared Content-Length is rejected up front when it
 * is valid and too large; a missing/invalid value is treated as unbounded and
 * caught by the streaming parser before the body is retained.
 */
const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_FILES * MAX_UPLOAD_FILE_BYTES + 1024 * 1024;

/** Max uploads in flight per server process (each holds one temp file set). */
const MAX_CONCURRENT_UPLOADS = (() => {
  const raw = Number(process.env.SWARM_MAX_CONCURRENT_UPLOADS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4;
})();

let activeUploads = 0;

/** Reserve a concurrency slot; returns null when the process is saturated. */
function acquireUploadSlot(): (() => void) | null {
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) return null;
  activeUploads += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeUploads = Math.max(0, activeUploads - 1);
  };
}

function unauthorized() {
  return NextResponse.json({ error: "Sign in required." }, { status: 401 });
}

function errorResponse(status: number, error: string, code: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, code, ...extra }, { status });
}

/**
 * Reject an upload and record the refusal in the audit log. Only called once
 * the caller is authenticated, so the user field is always meaningful.
 */
function reject(user: string, status: number, error: string, code: string, target: string, extra?: Record<string, unknown>) {
  recordAudit({ user, action: "vm.file.upload", target, result: "failure" });
  return errorResponse(status, error, code, extra);
}

/**
 * The gate for an upload that bypasses middleware. The host allowlist is
 * enforced in every mode (loopback in local mode, SWARM_ALLOWED_HOSTS in
 * server mode) and is checked before any body byte is read. If the host is
 * allowed, `user` is the authenticated caller's id, or null when unauthenticated
 * (server mode). The x-swarm-user header is never trusted here: identity comes
 * from the same gates middleware uses (host + session cookie / harness bearer).
 */
function caller(req: NextRequest): { denied: boolean; user: string | null } {
  if (!hostAllowed(req)) return { denied: true, user: null };
  return { denied: false, user: requestUser(req)?.id ?? null };
}

/**
 * Reduce a caller-supplied filename to a single safe path segment.
 *
 * Directory separators and control characters are refused outright (the same
 * rules lib/vm/files applies to paths), and an empty / "." / ".." name is
 * invalid. Shell metacharacters that could break the base64-decode exec
 * command (", $, `, !) are also rejected. Because "/" can never appear, a
 * sanitized name cannot escape the uploads directory; the destination is still
 * run through resolveWorkspacePath afterwards as defense in depth.
 */
function sanitizeFileName(raw: string): string {
  const name = raw.trim();
  if (!name || name === "." || name === "..") {
    throw new Error("empty");
  }
  if (/[\u0000-\u001f\u007f/\\]/.test(name)) {
    throw new Error("characters");
  }
  if (/["$`!]/.test(name)) {
    throw new Error("shell_meta");
  }
  return name;
}

/**
 * Make a destination path unique within a single upload batch. A second file
 * with the same name would otherwise silently overwrite the first; instead it
 * becomes "name (2).ext", "name (3).ext", ... until a free name is found.
 */
function uniqueTarget(name: string, used: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let i = 2;
  let candidate = resolveWorkspacePath(`${UPLOAD_DIR}/${stem} (${i})${ext}`);
  while (used.has(candidate)) {
    i += 1;
    candidate = resolveWorkspacePath(`${UPLOAD_DIR}/${stem} (${i})${ext}`);
  }
  return candidate;
}

export async function POST(req: NextRequest) {
  const { denied, user } = caller(req);
  // Host gate first: a non-allowlisted Host is refused with 403 before any body
  // byte is read or any file is written (b8). This mirrors the middleware's
  // host gate, which uploads bypass.
  if (denied) return errorResponse(403, "Forbidden.", "forbidden");
  // Server-mode rate limit, applied before reading the body (mirrors middleware).
  if (serverMode()) {
    const key = rateLimitKey(req, user ? { id: user } : null);
    const result = rateLimitCheck("/api/runtime/vm/files/upload", key);
    if (result && !result.allowed) return rateLimitResponse(result);
  }
  if (!user) return unauthorized();
  if (!isHarnessBearer(req) && isCrossSite(req)) {
    return errorResponse(403, "Cross-site request blocked.", "cross_site");
  }

  // Only a syntactically valid Content-Length can short-circuit the read.
  // Missing or malformed values are NOT treated as 0 (b22): the streaming
  // parser enforces the cap instead.
  const declared = req.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared)) {
    const declaredLength = Number(declared);
    if (declaredLength > MAX_UPLOAD_REQUEST_BYTES) {
      return reject(
        user,
        413,
        `Upload body exceeds the ${MAX_UPLOAD_REQUEST_BYTES} byte limit.`,
        "body_too_large",
        "request body",
        { limit: MAX_UPLOAD_REQUEST_BYTES },
      );
    }
  }

  const release = acquireUploadSlot();
  if (!release) {
    return reject(
      user,
      429,
      "Too many uploads are in progress. Try again in a moment.",
      "too_many_uploads",
      "request body",
      { limit: MAX_CONCURRENT_UPLOADS },
    );
  }

  let parsed: Awaited<ReturnType<typeof parseMultipartUpload>> | undefined;
  try {
    try {
      parsed = await parseMultipartUpload(req, {
        maxFiles: MAX_UPLOAD_FILES,
        maxFileBytes: MAX_UPLOAD_FILE_BYTES,
        maxRequestBytes: MAX_UPLOAD_REQUEST_BYTES,
      });
    } catch (err) {
      if (err instanceof UploadStreamError) {
        const target =
          typeof err.extra?.name === "string" ? err.extra.name : "request body";
        return reject(user, err.status, err.message, err.code, target, err.extra);
      }
      return errorResponse(400, "Could not read the multipart body.", "bad_request");
    }

    const parts: StreamedUploadFile[] = parsed.files;
    if (parts.length === 0) {
      return errorResponse(400, "No files were attached.", "no_files");
    }
    if (parts.length > MAX_UPLOAD_FILES) {
      return reject(
        user,
        400,
        `Too many files: at most ${MAX_UPLOAD_FILES} per message.`,
        "too_many_files",
        `${parts.length} files`,
        { limit: MAX_UPLOAD_FILES },
      );
    }

    // Validate everything before writing anything so a rejected upload never
    // leaves partial files in the VM. Only metadata is kept here; file bytes
    // are read one at a time during the write pass so a full batch never sits
    // in memory at once.
    const vm = getVmManager();
    const entries: Array<StreamedUploadFile & { target: string; resolvedTarget: string }> = [];
    const usedTargets = new Set<string>();
    for (const file of parts) {
      if (file.size > MAX_UPLOAD_FILE_BYTES) {
        return reject(
          user,
          413,
          `"${file.name}" is larger than 10 MB.`,
          "file_too_large",
          file.name,
          { name: file.name, limit: MAX_UPLOAD_FILE_BYTES },
        );
      }
      let name: string;
      try {
        name = sanitizeFileName(file.name);
      } catch {
        return reject(user, 400, `"${file.name}" is not a valid filename.`, "invalid_filename", file.name);
      }
      let target: string;
      try {
        target = resolveWorkspacePath(`${UPLOAD_DIR}/${name}`);
      } catch (err) {
        if (err instanceof VmPathError) {
          return errorResponse(err.code === "outside_workspace" ? 403 : 400, err.message, err.code);
        }
        return errorResponse(400, "Invalid destination path.", "invalid_path");
      }
      if (usedTargets.has(target)) {
        target = uniqueTarget(name, usedTargets);
      }
      usedTargets.add(target);

      // Symlink-safe destination check (VM-10): a workspace symlink (e.g.
      // /workspace/uploads -> /etc) must not redirect the write outside.
      let resolvedTarget: string;
      try {
        resolvedTarget = await vm.resolveSafePath(user, target, { allowMissing: true });
      } catch (err) {
        if (err instanceof VmPathError) {
          const status = err.code === "outside_workspace" ? 403 : 400;
          return reject(user, status, err.message, err.code, name);
        }
        return reject(user, 500, "Could not resolve the upload destination.", "vm_error", name);
      }

      entries.push({ ...file, name, target, resolvedTarget });
    }

    // VM-05: every write path checks the disk quota with the incoming size,
    // so an over-quota user cannot keep filling the host disk.
    const incomingBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    try {
      await vm.assertDiskQuota(user, incomingBytes);
    } catch (err) {
      if (err instanceof QuotaError) {
        return reject(user, 413, err.message, "disk_quota", "request body", {
          limit: err.limit,
          kind: err.kind,
        });
      }
      return reject(user, 500, "Could not check the disk quota.", "vm_error", "request body");
    }

    try {
      // The base64-decode path needs the directory to exist; writeFile creates
      // parents itself, but one idempotent mkdir covers both.
      const mkdir = await vm.exec(user, ["mkdir", "-p", UPLOAD_DIR]);
      if (mkdir.exitCode !== 0) {
        return reject(user, 500, "Could not create the uploads directory.", "vm_write_error", UPLOAD_DIR);
      }
      // Refuse a destination that already exists as a directory. Writing there
      // makes the shell (`cat > dir`, `base64 -d > dir`) exit before it consumes
      // stdin — the EPIPE path — so answer 4xx before spawning any writer. Only
      // an existing directory is a conflict; a missing path is the normal case.
      for (const entry of entries) {
        try {
          const info = await vm.stat(user, entry.resolvedTarget);
          if (info.type === "directory") {
            return reject(
              user,
              409,
              `"${entry.name}" already exists as a directory.`,
              "target_is_directory",
              entry.name,
            );
          }
        } catch (err) {
          if (err instanceof VmFileError && err.code === "not_found") continue;
          throw err;
        }
      }
      for (const entry of entries) {
        // Read and write one file at a time: a 10-file batch is then bounded by
        // MAX_UPLOAD_FILE_BYTES of live memory instead of the whole batch.
        const bytes = await readTempFile(entry.tempPath);
        if (looksBinary(bytes)) {
          // Binary bytes cannot survive a UTF-8 string write; pipe base64 into
          // `base64 -d` inside the VM so the file on disk is byte-exact. The
          // final component is refused if it is a symlink (O_NOFOLLOW
          // equivalent): the path was realpath-checked above, so this only
          // guards against a race.
          const res = await vm.exec(
            user,
            [
              "sh",
              "-c",
              'if [ -L "$1" ]; then echo "refusing to write through a symlink" >&2; exit 40; fi; tmp="$1.tmp.$$"; if base64 -d > "$tmp"; then mv -f "$tmp" "$1"; else rm -f "$tmp"; exit 42; fi',
              "sh",
              entry.resolvedTarget,
            ],
            { stdin: bytes.toString("base64") },
          );
          if (res.exitCode !== 0) {
            return reject(user, 500, `Could not write "${entry.name}".`, "vm_write_error", entry.name);
          }
        } else {
          await vm.writeFile(user, entry.resolvedTarget, bytes.toString("utf8"));
        }
      }
    } catch (err) {
      if (err instanceof QuotaError) {
        return reject(user, 413, err.message, "disk_quota", "request body", {
          limit: err.limit,
          kind: err.kind,
        });
      }
      // A directory that appeared between the stat check and the write (or a
      // driver that reports it directly) is a client-side path conflict, not a
      // server failure.
      if (err instanceof VmFileError && err.code === "not_a_file") {
        return reject(
          user,
          409,
          "A target path is a directory.",
          "target_is_directory",
          entries.map((e) => e.name).join(", "),
        );
      }
      // EPIPE-class stream errors mean the VM command closed its input early.
      // The exec call rejects with one of these; the process stays up and the
      // client gets a 4xx it can retry, not a 500 or a dead server.
      if (isKnownStreamError(err)) {
        return reject(
          user,
          409,
          "The VM stopped accepting input before the upload completed.",
          "write_interrupted",
          entries.map((e) => e.name).join(", "),
        );
      }
      console.error(`[upload] write failed for ${user}:`, err);
      return reject(user, 500, "Could not write the uploaded files.", "vm_write_error", entries.map((e) => e.name).join(", "));
    }

    recordAudit({
      user,
      action: "vm.file.upload",
      target: entries.map((e) => e.name).join(", "),
      result: "success",
    });

    return NextResponse.json({
      uploadDir: UPLOAD_DIR,
      uploaded: entries.map((e) => ({ name: e.name, path: e.target, size: e.size, type: e.type })),
    });
  } finally {
    await parsed?.dispose();
    release();
  }
}
