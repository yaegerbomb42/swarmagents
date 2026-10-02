import { scoped } from "@/lib/auth";
import { giveToUser } from "@/lib/sandbox";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { uploadDir } from "@/lib/agent";
import { getMeta } from "@/lib/store";
import type { Attachment } from "@/lib/types";
import { isLocal } from "@/middleware";

export const dynamic = "force-dynamic";

const GIB = 1024 ** 3;

function byteLimit(env: string | undefined, fallback: number) {
  const value = Number(env);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const MAX_UPLOAD_BYTES = byteLimit(process.env.SWARM_MAX_UPLOAD_BYTES, Number.MAX_SAFE_INTEGER);
const MIN_FREE_BYTES = byteLimit(process.env.SWARM_UPLOAD_MIN_FREE_BYTES, GIB);
const MAX_UPLOAD_LABEL = MAX_UPLOAD_BYTES >= GIB ? `${Math.floor(MAX_UPLOAD_BYTES / GIB)} GiB` : `${Math.floor(MAX_UPLOAD_BYTES / (1024 ** 2))} MiB`;

// Reserve the expected remaining bytes across simultaneous requests. Since the app runs in one
// Node process, this shared counter prevents two uploads from both spending the same free space.
const uploadRuntime = (globalThis as typeof globalThis & { __swarmUploadRuntime?: { reservedBytes: number; activePartials: Set<string> } }).__swarmUploadRuntime ??= { reservedBytes: 0, activePartials: new Set() };

class UploadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "UploadError";
  }
}

function availableBytes(dir: string) {
  const stat = fs.statfsSync(dir);
  return stat.bavail * stat.bsize;
}

function reserveFile(dir: string, name: string) {
  for (let i = 0; ; i++) {
    const file = path.join(dir, i ? name.replace(/(\.[^.]*)?$/, ` (${i})$1`) : name);
    try {
      return { file, fd: fs.openSync(file, "wx", 0o600) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function reservePartial(dir: string) {
  for (;;) {
    const file = path.join(dir, `.swarm-upload-${randomUUID()}.partial`);
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      uploadRuntime.activePartials.add(file);
      return { file, fd };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** Remove abandoned partials left when the process was killed before its request could clean up. */
function cleanupOrphanPartials(dir: string) {
  for (const name of fs.readdirSync(dir)) {
    if (!/^\.swarm-upload-[a-f0-9-]+\.partial$/.test(name)) continue;
    const file = path.join(dir, name);
    if (uploadRuntime.activePartials.has(file)) continue;
    try {
      fs.unlinkSync(file);
    } catch {}
  }
}

/** Streams uploads to disk with a configurable per-file ceiling and free-space reserve. */
async function postHandler(req: Request) {
  if (!isLocal(req)) return new Response("forbidden", { status: 403 });
  const u = new URL(req.url);
  const sessionId = u.searchParams.get("session") ?? "";
  if (!/^[a-f0-9]{16}$/.test(sessionId) || !req.body) return new Response("bad request", { status: 400 });
  if (!getMeta(sessionId)) return Response.json({ error: "Task not found." }, { status: 404 });

  const lengthHeader = req.headers.get("content-length");
  const declaredLength = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
  if (lengthHeader && declaredLength === null) return Response.json({ error: "Invalid upload length." }, { status: 400 });
  if (declaredLength === null) return Response.json({ error: "This upload needs a known file size so available disk space can be reserved safely." }, { status: 411 });
  if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_UPLOAD_BYTES)) {
    return Response.json({ error: `This file exceeds the configured ${MAX_UPLOAD_LABEL} upload limit.` }, { status: 413 });
  }

  const name = path.basename(u.searchParams.get("name") || "file").replace(/[^\w.\- ()]/g, "_").slice(0, 180);
  const dir = uploadDir(sessionId);
  cleanupOrphanPartials(dir);
  let reserved: { file: string; fd: number } | undefined;
  let finalReserved: { file: string; fd: number } | undefined;
  let partialPath: string | undefined;
  let budgetReserved = false;
  let remainingBudget = declaredLength;
  try {
    const free = availableBytes(dir);
    if (free - MIN_FREE_BYTES - uploadRuntime.reservedBytes < declaredLength) {
      throw new UploadError("There is not enough free disk space to safely save this file.", 507);
    }
    uploadRuntime.reservedBytes += declaredLength;
    budgetReserved = true;
    reserved = reservePartial(dir);
    partialPath = reserved.file;
    let size = 0;
    const sink = new Writable({
      write(chunk: Buffer | Uint8Array, _encoding, callback) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (size + data.length > declaredLength) return callback(new UploadError("The upload body was larger than its declared file size.", 400));
        size += data.length;
        const writeChunk = (offset: number) => {
          if (offset === data.length) return callback();
          fs.write(reserved!.fd, data, offset, data.length - offset, null, (error, written) => {
            if (error) return callback(error);
            uploadRuntime.reservedBytes -= written;
            remainingBudget -= written;
            try {
              if (availableBytes(dir) < MIN_FREE_BYTES + uploadRuntime.reservedBytes) {
                return callback(new UploadError("Upload stopped to preserve the configured free disk space reserve.", 507));
              }
            } catch {
              return callback(new UploadError("Could not confirm available disk space; upload stopped safely.", 507));
            }
            writeChunk(offset + written);
          });
        };
        writeChunk(0);
      },
    });
    await pipeline(Readable.fromWeb(req.body as import("stream/web").ReadableStream), sink);
    if (size !== declaredLength) throw new UploadError("The upload ended before the declared file size was received.", 400);
    fs.closeSync(reserved.fd);
    reserved.fd = -1;
    finalReserved = reserveFile(dir, name || "file");
    fs.closeSync(finalReserved.fd);
    finalReserved.fd = -1;
    fs.renameSync(reserved.file, finalReserved.file);
    uploadRuntime.activePartials.delete(reserved.file);
    reserved = { ...finalReserved, fd: -1 };
    finalReserved = undefined;
    // per-user sandbox: the upload belongs to the user, so their sandboxed tools can read it.
    giveToUser(reserved.file);
    const att: Attachment = {
      name: path.basename(reserved.file),
      path: reserved.file,
      size: fs.statSync(reserved.file).size,
      mime: (req.headers.get("content-type") || "application/octet-stream").slice(0, 160),
    };
    return Response.json(att);
  } catch (error) {
    if (reserved) {
      if (reserved.fd !== -1) {
        try {
          fs.closeSync(reserved.fd);
        } catch {}
      }
      try {
        fs.unlinkSync(reserved.file);
      } catch {}
    }
    if (finalReserved) {
      if (finalReserved.fd !== -1) {
        try {
          fs.closeSync(finalReserved.fd);
        } catch {}
      }
      try {
        fs.unlinkSync(finalReserved.file);
      } catch {}
    }
    const failure = error instanceof UploadError ? error : null;
    const noSpace = error instanceof Error && "code" in error && error.code === "ENOSPC";
    const message = failure?.message ?? (noSpace ? "There is not enough free disk space to save this file." : "Could not save the uploaded file.");
    return Response.json({ error: message }, { status: failure?.status ?? (noSpace ? 507 : 500) });
  } finally {
    if (partialPath) uploadRuntime.activePartials.delete(partialPath);
    if (budgetReserved) uploadRuntime.reservedBytes -= remainingBudget;
  }
}

// Every handler runs as the signed-in user, so all store paths resolve to that user's data.
export const POST = scoped(postHandler);
