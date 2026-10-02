import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAllowed } from "@/lib/auth";
import { UPLOADS_DIR, getMeta, sessionDir } from "@/lib/store";

export const dynamic = "force-dynamic";

// File previews for the timeline: GET /api/files?session=<id>&path=<file>[&download=1][&meta=1]
// Serves only files under the session's working directory or the server user's home (plus uploads and the
// session dir), refuses
// credential-looking paths, and sandboxes every response so agent-written HTML/SVG can't run script on
// this origin (which holds the owner's session).

const MAX_BYTES = 25 * 1024 * 1024;
const SECRETISH = /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.config\/gcloud|\.swarmagents)(\/|$)|(^|\/)\.env(\.|$)|(^|\/)\.netrc$|(^|\/)id_[a-z0-9]+(\.pub)?$|\.(pem|key|p12|pfx|keychain-db)$|(^|\/)(credentials|secrets?)(\.[a-z]+)?$/i;

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", ico: "image/x-icon", bmp: "image/bmp",
  pdf: "application/pdf",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
  csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", md: "text/markdown", markdown: "text/markdown",
  html: "text/html", htm: "text/html", xml: "text/xml",
  zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Text-like files we can show inline as text (code, configs, logs). */
const TEXTISH = /\.(txt|log|out|err|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|graphql|proto|lua|r|pl|ex|exs|erl|hs|scala|clj|vue|svelte|diff|patch|dockerfile|makefile|gitignore|env\.example)$|(^|\/)(Dockerfile|Makefile|README|LICENSE|CHANGELOG)$/i;

function within(root: string, p: string) {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realOrNull(p: string) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  if (!isAllowed(req)) return Response.json({ error: "Sign in required." }, { status: 401 });
  const u = new URL(req.url);
  const sid = u.searchParams.get("session") ?? "";
  let meta: ReturnType<typeof getMeta> = null;
  try {
    meta = getMeta(sid); // validates the id format itself
  } catch {}
  const want = u.searchParams.get("path") ?? "";
  if (!meta) return Response.json({ error: "Unknown session." }, { status: 404 });
  if (!want) return Response.json({ error: "Missing path." }, { status: 400 });

  const roots = [meta.cwd, os.homedir(), UPLOADS_DIR, sessionDir(meta.id)].map(realOrNull).filter((r): r is string => !!r);
  const file = realOrNull(path.resolve(meta.cwd, want.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")));
  if (!file || !roots.some((r) => within(r, file))) return Response.json({ error: "That file isn't in this task's working folder." }, { status: 404 });
  if (SECRETISH.test(file)) return Response.json({ error: "Previews of credential files are blocked." }, { status: 403 });
  const st = fs.statSync(file);
  if (!st.isFile()) return Response.json({ error: "Not a file." }, { status: 400 });

  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = MIME[ext] ?? (TEXTISH.test(file) ? "text/plain" : "application/octet-stream");
  const kind = mime.startsWith("image/") ? "image" : mime === "application/pdf" ? "pdf" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : ext === "csv" || ext === "tsv" ? "table" : ext === "md" || ext === "markdown" ? "markdown" : mime.startsWith("text/") || mime === "application/json" ? "text" : "binary";
  if (u.searchParams.get("meta") === "1") return Response.json({ path: file, name: path.basename(file), size: st.size, mtime: st.mtimeMs, mime, kind });

  const download = u.searchParams.get("download") === "1";
  if (st.size > MAX_BYTES && !download) return Response.json({ error: `Too large to preview (${(st.size / 1024 / 1024).toFixed(1)} MB). Use download.` }, { status: 413 });
  // Scripts never run: HTML/SVG/XML are sandboxed (opaque origin, no scripts) and typed so the browser can't sniff.
  const headers: Record<string, string> = {
    "Content-Type": mime.startsWith("text/") ? `${mime}; charset=utf-8` : mime,
    "Content-Length": String(st.size),
    // Chrome won't render a PDF under a sandbox CSP; its viewer runs PDF script in its own isolated process anyway.
    // Everything else is served into an opaque sandbox with no scripts, no inline styles, no form posts and no
    // object/embed: agent-written HTML/SVG/XML cannot reach the real origin or exfiltrate. (Reviewer-recommended set.)
    ...(mime === "application/pdf"
      ? {}
      : { "Content-Security-Policy": "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'" }),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
  };
  return new Response(fs.createReadStream(file) as unknown as ReadableStream, { headers });
}
