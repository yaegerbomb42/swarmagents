import fs from "node:fs";
import { getArtifact } from "@/lib/runtime";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// Types that, if served inline, run in the site's origin. An agent can write these, so they are
// never executed here: they are forced to download, and everything else gets a sandbox CSP.
const ACTIVE: Record<string, true> = { "text/html": true, "application/xhtml+xml": true, "image/svg+xml": true, "application/xml": true, "text/xml": true };

/** Security headers shared by every non-redirect branch: sandboxed, no-sniff, no script execution. */
function safeHeaders(mime: string, filename: string, download: boolean): Record<string, string> {
  const active = ACTIVE[(mime.split(";")[0] ?? "").trim().toLowerCase()] === true;
  const asDownload = download || active;
  return {
    "Content-Type": mime,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Content-Disposition": `${asDownload ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    // Chrome won't render a PDF under a sandbox CSP; its viewer isolates PDF script in its own process anyway.
    ...(mime === "application/pdf" ? {} : { "Content-Security-Policy": "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'" }),
  };
}

/**
 * Serve an artifact's content. For a file on disk we stream it with the recorded mime
 * type; otherwise we return the inline payload. The agent runs locally, so this only
 * ever reads paths the agent itself produced. Every response is sandboxed so agent-written
 * HTML/SVG/XML cannot run script in this origin (same policy as /api/files).
 */
export async function GET(req: Request, { params }: Ctx) {
  const id = (await params).id;
  const artifact = getArtifact(id);
  if (!artifact) return new Response("not found", { status: 404 });

  const url = new URL(req.url);

  // Metadata-only view.
  if (url.searchParams.get("meta") === "1") return Response.json({ artifact });
  const download = url.searchParams.get("download") === "1";

  if (artifact.path && fs.existsSync(artifact.path)) {
    const stat = fs.statSync(artifact.path);
    const type = artifact.mime ?? "application/octet-stream";
    const nodeStream = fs.createReadStream(artifact.path);
    return new Response(nodeStream as unknown as ReadableStream, {
      headers: { ...safeHeaders(type, basename(artifact.path), download), "Content-Length": String(stat.size) },
    });
  }

  if (artifact.text !== undefined) {
    const type = artifact.mime ?? "text/plain; charset=utf-8";
    return new Response(artifact.text, { headers: safeHeaders(type, artifact.title || id, download) });
  }

  if (artifact.url) return Response.redirect(artifact.url, 302);
  return new Response("artifact has no content", { status: 410 });
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}