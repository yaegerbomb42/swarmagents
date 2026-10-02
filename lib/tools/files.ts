import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync, type SpawnSyncOptionsWithBufferEncoding, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { userHome } from "../store";
import { clip, type Tool } from "./types";
import { assertInsideHome, defaultCwd, giveCreated, sandboxCommand } from "../sandbox";

// per-user sandbox: these tools run inside the server process, so on a server every path is confined to the
// user's workspace/uploads (symlinks resolved), "~" means that workspace, and helpers run as the user's uid.
export const resolvePath = (p: string, cwd: string) => assertInsideHome(path.resolve(cwd, String(p).replace(/^~(?=$|\/)/, defaultCwd(os.homedir()))));
function runSync(cmd: string, args: string[], opts: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
function runSync(cmd: string, args: string[], opts?: SpawnSyncOptionsWithBufferEncoding): SpawnSyncReturns<Buffer>;
function runSync(cmd: string, args: string[], opts: SpawnSyncOptionsWithStringEncoding | SpawnSyncOptionsWithBufferEncoding = {}): SpawnSyncReturns<string | Buffer> {
  const sb = sandboxCommand(cmd, args);
  return spawnSync(sb.command, sb.args, opts);
}

/** Checkpoints: full-file snapshots taken before every write/edit, stored per session. */
const checkpointsDir = (sessionId: string) => {
  const d = path.join(userHome(), "checkpoints", sessionId);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};

/** Retention policy: keeps 24h trust without disk blowup on long runs. */
export const CHECKPOINT_LIMITS = {
  /** Max total bytes kept per session dir. Oldest snapshots evicted first. */
  maxBytesPerSession: 500_000_000,
  /** Max age before a snapshot is eligible for GC. */
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  /** Max snapshots kept per session dir. */
  maxFilesPerSession: 500,
};

function checkpointMeta(bak: string): { path: string; at: number } | null {
  try {
    return JSON.parse(fs.readFileSync(`${bak}.json`, "utf8")) as { path: string; at: number };
  } catch {
    return null;
  }
}

function listSnapshots(sessionId: string): { bak: string; bytes: number; at: number }[] {
  const d = path.join(userHome(), "checkpoints", sessionId);
  let names: string[] = [];
  try {
    names = fs.readdirSync(d);
  } catch {
    return [];
  }
  const out: { bak: string; bytes: number; at: number }[] = [];
  for (const n of names) {
    if (!n.endsWith(".bak")) continue;
    const bak = path.join(d, n);
    try {
      const st = fs.statSync(bak);
      // A snapshot without a readable sidecar is un-restorable — treat it as garbage and drop it on next GC.
      const meta = checkpointMeta(bak);
      if (!meta) {
        removeSnapshot(bak);
        continue;
      }
      out.push({ bak, bytes: st.size, at: meta.at ?? st.mtimeMs });
    } catch {
      // dangling sidecar or removed file — ignore
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

function removeSnapshot(bak: string) {
  try {
    fs.rmSync(bak, { force: true });
  } catch {}
  try {
    fs.rmSync(`${bak}.json`, { force: true });
  } catch {}
}

/** Evict oldest snapshots until the session dir is back inside CHECKPOINT_LIMITS. Returns evicted count. */
export function gcCheckpoints(sessionId: string): number {
  const snaps = listSnapshots(sessionId);
  if (!snaps.length) return 0;
  const now = Date.now();
  let evicted = 0;
  // Age-based first.
  for (const s of snaps) {
    if (now - s.at > CHECKPOINT_LIMITS.maxAgeMs) {
      removeSnapshot(s.bak);
      evicted++;
    }
  }
  let live = listSnapshots(sessionId);
  const totalBytes = () => live.reduce((n, s) => n + s.bytes, 0);
  // Count-based, then size-based — oldest first.
  while (live.length > CHECKPOINT_LIMITS.maxFilesPerSession) {
    removeSnapshot(live[0].bak);
    evicted++;
    live = live.slice(1);
  }
  while (live.length && totalBytes() > CHECKPOINT_LIMITS.maxBytesPerSession) {
    removeSnapshot(live[0].bak);
    evicted++;
    live = live.slice(1);
  }
  return evicted;
}

/** Remove every snapshot for a session (called on session delete). */
export function clearCheckpoints(sessionId: string) {
  try {
    fs.rmSync(path.join(userHome(), "checkpoints", sessionId), { recursive: true, force: true });
  } catch {}
}

export function checkpointUsage(sessionId: string): { files: number; bytes: number } {
  const snaps = listSnapshots(sessionId);
  return { files: snaps.length, bytes: snaps.reduce((n, s) => n + s.bytes, 0) };
}

export function snapshotFile(sessionId: string, absPath: string): string | null {
  try {
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
    if (fs.statSync(absPath).size > 25_000_000) return null; // don't snapshot huge files
    const id = crypto.randomBytes(6).toString("hex");
    const dest = path.join(checkpointsDir(sessionId), `${id}.bak`);
    fs.copyFileSync(absPath, dest);
    // Sidecar records which file this snapshot belongs to.
    fs.writeFileSync(`${dest}.json`, JSON.stringify({ path: absPath, at: Date.now() }), { mode: 0o600 });
    gcCheckpoints(sessionId);
    return id;
  } catch {
    return null;
  }
}

/** Marker line the Timeline parses to render diffs + an undo affordance. Survives compaction as plain text. */
export const checkpointMarker = (checkpointId: string, absPath: string) =>
  `[checkpoint ${checkpointId} path=${absPath}]`;

export function restoreCheckpoint(sessionId: string, checkpointId: string): { ok: boolean; message: string } {
  if (!/^[a-f0-9]+$/.test(checkpointId)) return { ok: false, message: "Bad checkpoint id." };
  // Defense in depth: the id is hex-only and checkpointsDir is fixed, so no traversal is possible,
  // but resolve + prefix-check anyway in case the id source ever changes.
  const dir = checkpointsDir(sessionId);
  const bak = path.resolve(dir, `${checkpointId}.bak`);
  if (!bak.startsWith(dir + path.sep)) return { ok: false, message: "Bad checkpoint id." };
  const meta = `${bak}.json`;
  if (!fs.existsSync(bak) || !fs.existsSync(meta)) return { ok: false, message: `Checkpoint ${checkpointId} not found for this task.` };
  try {
    const { path: absPath } = JSON.parse(fs.readFileSync(meta, "utf8")) as { path: string };
    if (typeof absPath !== "string" || !path.isAbsolute(absPath)) return { ok: false, message: "Checkpoint record is invalid; refusing to restore." };
    assertInsideHome(absPath);
    const made = fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.copyFileSync(bak, absPath);
    giveCreated(absPath, made);
    return { ok: true, message: `Restored ${absPath} from checkpoint ${checkpointId}.` };
  } catch (e) {
    return { ok: false, message: `Restore failed: ${(e as Error).message}` };
  }
}

const IMAGE: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

function isBinary(buf: Buffer) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export const readFile: Tool = {
  spec: {
    name: "read_file",
    description:
      "Read a file of any size, paged by line (offset/limit). Images are returned visually. PDFs, Office docs and other formats are converted to text when possible. For huge files read in pages or grep first.",
    schema: {
      type: "object",
      properties: { path: { type: "string" }, offset: { type: "number", description: "1-based start line" }, limit: { type: "number", description: "Lines, default 2000" } },
      required: ["path"],
    },
  },
  async run(input, ctx) {
    const f = resolvePath(String(input.path), ctx.cwd);
    const st = fs.statSync(f);
    if (st.isDirectory()) {
      const items = fs.readdirSync(f, { withFileTypes: true }).map((d) => d.name + (d.isDirectory() ? "/" : ""));
      return { content: clip(items.join("\n")) };
    }
    const ext = path.extname(f).toLowerCase();
    if (IMAGE[ext] && st.size < 20_000_000) return { content: `Image ${f} (${st.size} bytes)`, images: [{ mediaType: IMAGE[ext], data: fs.readFileSync(f).toString("base64") }] };

    let text = "";
    if ([".pdf", ".docx", ".doc", ".rtf", ".pptx", ".xlsx", ".odt", ".pages"].includes(ext)) {
      if (ext === ".pdf") {
        // Try pdftotext -> python3 pypdf -> mdls sequentially with direct arguments, no shell.
        const p1 = runSync("pdftotext", ["-layout", f, "-"], { maxBuffer: 1 << 30 });
        if (p1.stdout && p1.stdout.toString().trim()) {
          text = p1.stdout.toString();
        } else {
          const pyScript = "import sys\nfrom pypdf import PdfReader\nprint('\\n'.join(p.extract_text() or '' for p in PdfReader(sys.argv[1]).pages))";
          const p2 = runSync("python3", ["-c", pyScript, f], { maxBuffer: 1 << 30 });
          if (p2.stdout && p2.stdout.toString().trim()) {
            text = p2.stdout.toString();
          } else {
            const p3 = runSync("mdls", ["-raw", "-name", "kMDItemTextContent", f], { maxBuffer: 1 << 30 });
            if (p3.stdout && p3.stdout.toString().trim()) {
              text = p3.stdout.toString();
            }
          }
        }
      } else {
        const r = runSync("textutil", ["-convert", "txt", "-stdout", f], { maxBuffer: 1 << 30 });
        text = r.stdout?.toString() ?? "";
      }
      if (!text.trim()) return { content: `Could not extract text from ${f}. Try the bash tool (e.g. pip install pypdf / brew install poppler).`, isError: true };
    } else {
      // Stream only what we need so multi-GB files are fine.
      const fd = fs.openSync(f, "r");
      const head = Buffer.alloc(Math.min(st.size, 8000));
      fs.readSync(fd, head, 0, head.length, 0);
      if (isBinary(head)) {
        fs.closeSync(fd);
        const r = runSync("file", ["-b", f]);
        return { content: `Binary file ${f} (${st.size} bytes): ${r.stdout?.toString().trim()}. Use bash (xxd, strings, unzip, sqlite3, …) to inspect.` };
      }
      fs.closeSync(fd);
      if (st.size > 50_000_000) {
        const offset = Math.max(1, Number(input.offset ?? 1));
        const limit = Number(input.limit ?? 2000);
        const r = runSync("sed", ["-n", `${offset},${offset + limit - 1}p`, f], { maxBuffer: 1 << 28 });
        const total = runSync("wc", ["-l", f]).stdout.toString().trim().split(/\s+/)[0];
        return { content: clip(number(r.stdout.toString().split("\n"), offset) + `\n[lines ${offset}-${offset + limit - 1} of ${total}]`, 60_000) };
      }
      text = fs.readFileSync(f, "utf8");
    }
    const lines = text.split("\n");
    const offset = Math.max(1, Number(input.offset ?? 1));
    const limit = Number(input.limit ?? 2000);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const more = offset - 1 + limit < lines.length ? `\n[showing ${offset}-${offset + slice.length - 1} of ${lines.length} lines; use offset to continue]` : "";
    return { content: clip(number(slice, offset) + more, 60_000) };
  },
};

function number(lines: string[], start: number) {
  return lines.map((l, i) => `${String(start + i).padStart(6)}\t${l.length > 2000 ? l.slice(0, 2000) + "…" : l}`).join("\n");
}

export const writeFile: Tool = {
  spec: {
    name: "write_file",
    description:
      "Create or overwrite a file with the given content. Parent folders are created. A pre-write snapshot is taken automatically; the checkpoint id in the result can be passed to restore_checkpoint to undo.",
    schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  async run(input, ctx) {
    const f = resolvePath(String(input.path), ctx.cwd);
    const madeDir = fs.mkdirSync(path.dirname(f), { recursive: true });
    const existed = fs.existsSync(f);
    let before = "";
    if (existed) {
      try {
        const buf = fs.readFileSync(f);
        before = buf.includes(0) ? `[binary, ${buf.length} bytes — no text preview]` : buf.toString("utf8").slice(0, 4000);
      } catch {
        before = "";
      }
    }
    const cp = snapshotFile(ctx.sessionId, f);
    fs.writeFileSync(f, String(input.content ?? ""));
    // per-user sandbox: a file the server created belongs to the user, so their own shell can edit it later.
    if (!existed) giveCreated(f, madeDir);
    const lines = String(input.content ?? "").split("\n").length;
    const head = [`${existed ? "Overwrote" : "Created"} ${f} (${lines} lines)`];
    if (cp) head.push(checkpointMarker(cp, f));
    if (existed && before) head.push("--- before (first 4k)---", clip(before, 3000));
    head.push("+++ after (first 4k) +++", clip(String(input.content ?? "").slice(0, 4000), 3000));
    return { content: head.join("\n") };
  },
};

export const editFile: Tool = {
  spec: {
    name: "edit_file",
    description:
      "Replace an exact string in a file. old_string must match exactly (including whitespace) and be unique unless replace_all is true. Read the file first. A pre-edit snapshot is taken automatically; the checkpoint id in the result can be passed to restore_checkpoint to undo.",
    schema: {
      type: "object",
      properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } },
      required: ["path", "old_string", "new_string"],
    },
  },
  async run(input, ctx) {
    const f = resolvePath(String(input.path), ctx.cwd);
    const src = fs.readFileSync(f, "utf8");
    const oldS = String(input.old_string);
    const newS = String(input.new_string);
    const count = oldS ? src.split(oldS).length - 1 : 0;
    if (!count) return { content: `old_string not found in ${f}. Re-read the file and match it exactly.`, isError: true };
    if (count > 1 && !input.replace_all) return { content: `old_string occurs ${count} times in ${f}. Add surrounding context or set replace_all.`, isError: true };
    const cp = snapshotFile(ctx.sessionId, f);
    const out = input.replace_all ? src.split(oldS).join(newS) : src.replace(oldS, () => newS);
    fs.writeFileSync(f, out);
    const line = src.slice(0, src.indexOf(oldS)).split("\n").length;
    const head = [`Edited ${f} (${count} replacement${count > 1 ? "s" : ""}, near line ${line})`];
    if (cp) head.push(checkpointMarker(cp, f));
    head.push("--- old", clip(oldS, 3000), "+++ new", clip(newS, 3000));
    return { content: head.join("\n") };
  },
};

export const undoEdit: Tool = {
  spec: {
    name: "restore_checkpoint",
    description:
      "Undo a write_file/edit_file by restoring the file to its checkpoint snapshot. The checkpoint id appears in the tool output as [checkpoint <id> path=...]. Only restores files changed in this task.",
    schema: { type: "object", properties: { checkpoint: { type: "string" } }, required: ["checkpoint"] },
  },
  async run(input, ctx) {
    const r = restoreCheckpoint(ctx.sessionId, String(input.checkpoint ?? ""));
    return { content: r.message, isError: !r.ok };
  },
};

export const grep: Tool = {
  spec: {
    name: "search",
    description:
      "Fast code/text search with ripgrep. mode=content returns matching lines; mode=files lists matching files; set pattern to '' and glob to list files by name (e.g. glob='**/*.tsx').",
    schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex" },
        path: { type: "string" },
        glob: { type: "string" },
        mode: { type: "string", enum: ["content", "files"] },
        ignore_case: { type: "boolean" },
        context: { type: "number" },
      },
      required: ["pattern"],
    },
  },
  async run(input, ctx) {
    const dir = resolvePath(String(input.path ?? "."), ctx.cwd);
    const args = ["--color=never", "--max-columns=400", "--max-columns-preview"];
    if (input.glob) args.push("-g", String(input.glob));
    if (input.ignore_case) args.push("-i");
    const pattern = String(input.pattern ?? "");
    if (!pattern) args.push("--files");
    else {
      if (input.mode === "files") args.push("-l");
      else args.push("-n", ...(input.context ? ["-C", String(input.context)] : []));
      args.push("-e", pattern);
    }
    args.push(dir);
    const r = runSync("rg", args, { maxBuffer: 1 << 28, encoding: "utf8" });
    const out = (r.stdout || "").trim();
    if (!out) return { content: r.stderr?.trim() || "No matches." };
    const lines = out.split("\n");
    return { content: clip(lines.slice(0, 2000).join("\n") + (lines.length > 2000 ? `\n[${lines.length - 2000} more lines]` : ""), 40_000) };
  },
};
