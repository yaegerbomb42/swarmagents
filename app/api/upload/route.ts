import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { uploadDir } from "@/lib/agent";
import type { Attachment } from "@/lib/types";
import { isLocal } from "@/middleware";

export const dynamic = "force-dynamic";

/** Streams the raw body straight to disk, so files of any size work without buffering in memory. */
export async function POST(req: Request) {
  if (!isLocal(req)) return new Response("forbidden", { status: 403 });
  const u = new URL(req.url);
  const sessionId = u.searchParams.get("session") ?? "";
  if (!/^[a-f0-9]{16}$/.test(sessionId) || !req.body) return new Response("bad request", { status: 400 });
  const name = path.basename(u.searchParams.get("name") || "file").replace(/[^\w.\- ()]/g, "_");
  const dir = uploadDir(sessionId);
  let file = path.join(dir, name);
  for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, name.replace(/(\.[^.]*)?$/, ` (${i})$1`));
  await pipeline(Readable.fromWeb(req.body as import("stream/web").ReadableStream), fs.createWriteStream(file));
  const att: Attachment = { name, path: file, size: fs.statSync(file).size, mime: req.headers.get("content-type") || "application/octet-stream" };
  return Response.json(att);
}
