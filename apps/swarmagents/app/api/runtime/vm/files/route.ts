/**
 * VM file browser API.
 *
 * GET /api/runtime/vm/files?path=<abs path>       -> directory listing
 * GET /api/runtime/vm/files?path=<abs path>&read=1 -> file content
 * GET /api/runtime/vm/files?path=<abs path>&download=1 -> raw file bytes
 *   (Content-Disposition: attachment, capped at MAX_FILE_DOWNLOAD_BYTES)
 *
 * The path is resolved inside the user's own VM and scoped to /workspace:
 * traversal ("../") and paths outside the workspace are refused before any
 * driver call. Reads are capped at 1 MB and binary files are detected instead
 * of being returned as text. Downloads serve whole files only: a file over
 * the download cap is refused with 413, never truncated.
 *
 * Auth comes from the middleware-set x-swarm-user header (see lib/auth).
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../lib/auth";
import { getVmManager } from "../../../../../lib/vm/manager";
import {
  DEFAULT_RECENT_WINDOW_MS,
  MAX_FILE_DOWNLOAD_BYTES,
  MAX_FILE_READ_BYTES,
  MAX_RECENT_FILES,
  MAX_RECENT_WALK_DEPTH,
  MAX_RECENT_WALK_ENTRIES,
  MAX_RECENT_WINDOW_MS,
  VmFileError,
  VmPathError,
  WORKSPACE_ROOT,
  downloadContentDisposition,
  downloadContentType,
  foldRecentDir,
  looksBinary,
  parentPath,
  rankRecentFiles,
  resolveWorkspacePath,
  type VmRecentFile,
} from "../../../../../lib/vm/files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function unauthorized() {
  return NextResponse.json({ error: "Sign in required." }, { status: 401 });
}

function errorResponse(status: number, error: string, code: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, code, ...extra }, { status });
}

function clampNumber(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = value === null ? NaN : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

/**
 * Bounded workspace walk returning the files modified since `since`, most
 * recent first. Depth- and entry-capped so a huge workspace can never turn a
 * poll request into a scan; `budget.visited` is shared across the recursion.
 */
async function recentFiles(
  vm: ReturnType<typeof getVmManager>,
  user: string,
  root: string,
  since: number,
  budget: { visited: number },
  depth: number,
): Promise<VmRecentFile[]> {
  if (depth > MAX_RECENT_WALK_DEPTH || budget.visited >= MAX_RECENT_WALK_ENTRIES) return [];
  let entries;
  try {
    entries = await vm.listDir(user, root);
  } catch (err) {
    // A vanished directory (or an unreadable one) just contributes nothing;
    // real driver failures (unsupported) propagate to the caller.
    if (err instanceof VmFileError && (err.code === "not_found" || err.code === "not_a_directory")) return [];
    throw err;
  }
  const { files, subdirs } = foldRecentDir(entries, since, budget);
  for (const subdir of subdirs) {
    if (budget.visited >= MAX_RECENT_WALK_ENTRIES) break;
    files.push(...(await recentFiles(vm, user, subdir, since, budget, depth + 1)));
  }
  return files;
}

/** GET with recent=1: the workspace's recently-touched files. */
async function recentResponse(req: NextRequest, user: string, url: URL) {
  let path: string;
  try {
    path = resolveWorkspacePath(url.searchParams.get("path"));
  } catch (err) {
    if (err instanceof VmPathError) {
      const status = err.code === "outside_workspace" ? 403 : 400;
      return errorResponse(status, err.message, err.code);
    }
    return errorResponse(400, "Invalid path.", "invalid_path");
  }
  const windowMs = clampNumber(
    url.searchParams.get("windowMs"),
    DEFAULT_RECENT_WINDOW_MS,
    1,
    MAX_RECENT_WINDOW_MS,
  );
  const limit = clampNumber(url.searchParams.get("limit"), MAX_RECENT_FILES, 1, MAX_RECENT_FILES);
  const vm = getVmManager();
  try {
    const stat = await vm.stat(user, path);
    if (stat.type !== "directory") {
      return errorResponse(400, "Path is not a directory.", "not_a_directory");
    }
    const since = Date.now() - windowMs;
    const found = await recentFiles(vm, user, path, since, { visited: 0 }, 0);
    return NextResponse.json(
      {
        path,
        kind: "recent",
        since,
        windowMs,
        files: rankRecentFiles(found, limit),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof VmPathError) {
      const status = err.code === "outside_workspace" ? 403 : 400;
      return errorResponse(status, err.message, err.code);
    }
    if (err instanceof VmFileError) {
      switch (err.code) {
        case "not_found":
          return errorResponse(404, err.message, err.code);
        case "not_a_directory":
          return errorResponse(400, err.message, err.code);
        default:
          return errorResponse(501, err.message, err.code);
      }
    }
    return errorResponse(500, "Could not read the VM filesystem.", "vm_error");
  }
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();

  const url = new URL(req.url);
  if (url.searchParams.get("recent") === "1") {
    return recentResponse(req, user, url);
  }
  const rawPath = url.searchParams.get("path");
  const readParam = url.searchParams.get("read");
  const wantsRead = readParam !== null && readParam !== "0" && readParam !== "false";
  const downloadParam = url.searchParams.get("download");
  const wantsDownload =
    downloadParam !== null && downloadParam !== "0" && downloadParam !== "false";

  let path: string;
  try {
    path = resolveWorkspacePath(rawPath);
  } catch (err) {
    if (err instanceof VmPathError) {
      const status = err.code === "outside_workspace" ? 403 : 400;
      return errorResponse(status, err.message, err.code);
    }
    return errorResponse(400, "Invalid path.", "invalid_path");
  }

  const vm = getVmManager();

  try {
    if (wantsDownload) {
      // Same auth and path-safety as ?read=1 (caller + resolveWorkspacePath
      // above); the download is owner-only because the VM handle is per user.
      const stat = await vm.stat(user, path);
      if (stat.type === "directory") {
        return errorResponse(400, "Path is a directory.", "is_a_directory");
      }
      if (stat.size > MAX_FILE_DOWNLOAD_BYTES) {
        return errorResponse(
          413,
          `File exceeds the ${MAX_FILE_DOWNLOAD_BYTES} byte download limit.`,
          "file_too_large",
          { size: stat.size, limit: MAX_FILE_DOWNLOAD_BYTES },
        );
      }
      const file = await vm.readFileBytes(user, path, MAX_FILE_DOWNLOAD_BYTES);
      if (file.truncated) {
        // The file grew between stat and read; never serve a partial download.
        return errorResponse(
          413,
          `File exceeds the ${MAX_FILE_DOWNLOAD_BYTES} byte download limit.`,
          "file_too_large",
          { size: file.size, limit: MAX_FILE_DOWNLOAD_BYTES },
        );
      }
      return new NextResponse(new Uint8Array(file.content), {
        status: 200,
        headers: {
          "content-type": downloadContentType(path),
          "content-disposition": downloadContentDisposition(path),
          "content-length": String(file.content.length),
          "cache-control": "no-store",
        },
      });
    }

    if (wantsRead) {
      const stat = await vm.stat(user, path);
      if (stat.type === "directory") {
        return errorResponse(400, "Path is a directory.", "is_a_directory");
      }
      const file = await vm.readFileBytes(user, path, MAX_FILE_READ_BYTES);
      const binary = looksBinary(file.content);
      return NextResponse.json({
        path,
        kind: "file",
        size: file.size,
        truncated: file.truncated,
        binary,
        limit: MAX_FILE_READ_BYTES,
        // Binary payloads are not returned as text; the UI shows a placeholder.
        ...(binary ? {} : { content: file.content.toString("utf8") }),
      });
    }

    const stat = await vm.stat(user, path);
    if (stat.type !== "directory") {
      return errorResponse(400, "Path is not a directory.", "not_a_directory");
    }
    const entries = await vm.listDir(user, path);
    return NextResponse.json({
      path,
      kind: "directory",
      root: WORKSPACE_ROOT,
      parent: parentPath(path),
      entries,
    });
  } catch (err) {
    if (err instanceof VmPathError) {
      // The lexical path was fine, but a symlink inside the VM resolved
      // outside /workspace (VM-10). Refuse rather than leak the target.
      const status = err.code === "outside_workspace" ? 403 : 400;
      return errorResponse(status, err.message, err.code);
    }
    if (err instanceof VmFileError) {
      switch (err.code) {
        case "not_found":
          return errorResponse(404, err.message, err.code);
        case "not_a_directory":
          return errorResponse(400, err.message, err.code);
        case "not_a_file":
          return errorResponse(400, err.message, err.code);
        default:
          return errorResponse(501, err.message, err.code);
      }
    }
    return errorResponse(500, "Could not read the VM filesystem.", "vm_error");
  }
}
