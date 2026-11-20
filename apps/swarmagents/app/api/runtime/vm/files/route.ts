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
  MAX_FILE_DOWNLOAD_BYTES,
  MAX_FILE_READ_BYTES,
  VmFileError,
  VmPathError,
  WORKSPACE_ROOT,
  downloadContentDisposition,
  downloadContentType,
  looksBinary,
  parentPath,
  resolveWorkspacePath,
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

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();

  const url = new URL(req.url);
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
