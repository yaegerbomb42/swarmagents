import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { uploadDir } from "@/lib/agent";
import { getMeta } from "@/lib/store";
import type { Attachment } from "@/lib/types";
import { isLocal } from "@/middleware";

export const dynamic = "force-dynamic";

const GIB = 1024 ** 3;
const CHECK_DISK_EVERY = 64 * 1024 ** 2;

function byteLimit(env: string | undefined, fallback: number) {
  const value = Number(env);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const MAX_UPLOAD_BYTES = byteLimit(process.env.SWARM_MAX_UPLOAD_BYTES, Number.MAX_SAFE_INTEGER);
const MIN_FREE_BYTES = byteLimit(process.env.SWARM_UPLOAD_MIN_FREE_BYTES, GIB);
const MAX_UPLOAD_LABEL = MAX_UPLOAD_BYTES >= GIB ? `${Math.floor(MAX_UPLOAD_BYTES / GIB)} GiB` : `${Math.floor(MAX_UPLOAD_BYTES / (1024 ** 2))} MiB`;

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

/** Streams uploads to disk with a configurable per-file ceiling and free-space reserve. */
export async function POST(req: Request) {
  if (!isLocal(req)) return new Response("forbidden", { status: 403 });
  const u = new URL(req.url);
  const sessionId = u.searchParams.get("session") ?? "";
  if (!/^[a-f0-9]{16}$/.test(sessionId) || !req.body) return new Response("bad request", { status: 400 });
  if (!getMeta(sessionId)) return Response.json({ error: "Task not found." }, { status: 404 });

  const lengthHeader = req.headers.get("content-length");
  const declaredLength = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
  if (lengthHeader && declaredLength === null) return Response.json({ error: "Invalid upload length." }, { status: 400 });
  if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_UPLOAD_BYTES)) {
    return Response.json({ error: `This file exceeds the configured ${MAX_UPLOAD_LABEL} upload limit.` }, { status: 413 });
  }

  const name = path.basename(u.searchParams.get("name") || "file").replace(/[^\w.\- ()]/g, "_");
  const dir = uploadDir(sessionId);
  let reserved: { file: string; fd: number } | undefined;
  let writeStream: fs.WriteStream | null = null;
  try {
    const free = availableBytes(dir);
    if (free <= MIN_FREE_BYTES || (declaredLength !== null && free - MIN_FREE_BYTES < declaredLength)) {
      throw new UploadError("There is not enough free disk space to safely save this file.", 507);
    }
    reserved = reserveFile(dir, name || "file");
    let size = 0;
    let nextDiskCheck = CHECK_DISK_EVERY;
    const guard = new Transform({
      transform(chunk: Buffer | string, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        size += bytes;
        if (size > MAX_UPLOAD_BYTES) return callback(new UploadError(`This file exceeds the configured ${MAX_UPLOAD_LABEL} upload limit.`, 413));
        if (size >= nextDiskCheck) {
          nextDiskCheck = size + CHECK_DISK_EVERY;
          try {
            if (availableBytes(dir) < MIN_FREE_BYTES) return callback(new UploadError("Upload stopped to preserve the configured free disk space reserve.", 507));
          } catch {
            return callback(new UploadError("Could not confirm available disk space; upload stopped safely.", 507));
          }
        }
        callback(null, chunk);
      },
    });
    writeStream = fs.createWriteStream(reserved.file, { fd: reserved.fd, autoClose: true });
    await pipeline(Readable.fromWeb(req.body as import("stream/web").ReadableStream), guard, writeStream);
    const att: Attachment = {
      name: path.basename(reserved.file),
      path: reserved.file,
      size: fs.statSync(reserved.file).size,
      mime: (req.headers.get("content-type") || "application/octet-stream").slice(0, 160),
    };
    return Response.json(att);
  } catch (error) {
    if (reserved) {
      if (writeStream) writeStream.destroy();
      else try { fs.closeSync(reserved.fd); } catch {}
      try {
        fs.unlinkSync(reserved.file);
      } catch {}
    }
    const failure = error instanceof UploadError ? error : null;
    return Response.json({ error: failure?.message ?? "Could not save the uploaded file." }, { status: failure?.status ?? 500 });
  }
}
