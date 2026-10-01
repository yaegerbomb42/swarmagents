import fs from "node:fs";
import { getArtifact } from "@/lib/runtime";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Serve an artifact's content. For a file on disk we stream it with the recorded mime
 * type; otherwise we return the inline payload. The agent runs locally, so this only
 * ever reads paths the agent itself produced.
 */
export async function GET(req: Request, { params }: Ctx) {
  const id = (await params).id;
  const artifact = getArtifact(id);
  if (!artifact) return new Response("not found", { status: 404 });

  const url = new URL(req.url);

  // Metadata-only view.
  if (url.searchParams.get("meta") === "1") return Response.json({ artifact });

  if (artifact.path && fs.existsSync(artifact.path)) {
    const stat = fs.statSync(artifact.path);
    const type = artifact.mime ?? "application/octet-stream";
    // A web page artifact: hand back the file for download rather than inline-executing it.
    const disposition = url.searchParams.get("download") === "1" ? `attachment; filename="${basename(artifact.path)}"` : "inline";
    const nodeStream = fs.createReadStream(artifact.path);
    return new Response(nodeStream as unknown as ReadableStream, {
      headers: { "Content-Type": type, "Content-Length": String(stat.size), "Content-Disposition": disposition },
    });
  }

  if (artifact.text !== undefined) {
    return new Response(artifact.text, { headers: { "Content-Type": artifact.mime ?? "text/plain; charset=utf-8" } });
  }

  if (artifact.url) return Response.redirect(artifact.url, 302);
  return new Response("artifact has no content", { status: 410 });
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}