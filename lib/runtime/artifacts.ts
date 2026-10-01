// Artifact store: results as first-class objects.
//
// Anything the agent produces that the user might want again - a written file, a
// screenshot, a diff, a URL, a block of structured data - is registered here. The store
// keeps an index in one small JSON file; the payload stays wherever the agent wrote it,
// so registering a 2 GB file costs nothing.

import fs from "node:fs";
import path from "node:path";
import { loadArtifacts, rtId, withArtifacts } from "./store";
import type { Artifact, ArtifactKind } from "./types";

export interface RegisterArtifactInput {
  taskId: string;
  runId?: string;
  kind: ArtifactKind;
  title: string;
  path?: string;
  text?: string;
  url?: string;
  mime?: string;
}

const MAX_INLINE = 200_000;

function guessKind(p: string | undefined, mime: string | undefined): ArtifactKind {
  if (mime?.startsWith("image/")) return "image";
  if (mime === "application/json") return "data";
  const ext = p?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (["diff", "patch"].includes(ext)) return "diff";
  if (["log", "out", "err"].includes(ext)) return "log";
  if (["json", "csv", "tsv", "yaml", "yml", "xml"].includes(ext)) return "data";
  if (["txt", "md", "markdown", "rst", "text"].includes(ext) || mime === "text/plain" || mime === "text/markdown") return "text";
  return p ? "file" : "text";
}

export async function registerArtifact(input: RegisterArtifactInput): Promise<Artifact> {
  let size: number | undefined;
  let mime = input.mime;
  let kind = input.kind;

  if (input.path) {
    try {
      const st = fs.statSync(input.path);
      size = st.size;
      if (!mime) mime = guessMime(input.path);
      if (!kind) kind = guessKind(input.path, mime);
    } catch {
      // Path may be virtual (e.g. a URL preview); keep the record anyway.
    }
  }

  // Auto-classify when the caller passed a generic kind. A caller that says "file" is
  // usually satisfied with a more specific kind (text/data/log/image) that lets the UI
  // preview it, so refine "file" via the path/mime when we can.
  if (!kind || kind === "file") {
    const guessed = guessKind(input.path, mime);
    if (guessed !== "file" || !kind) kind = guessed;
  }

  let text = input.text;
  // Inline small text files so the UI can render them without a second request.
  if (!text && input.path && size !== undefined && size <= MAX_INLINE && (kind === "text" || kind === "log" || kind === "data" || kind === "diff")) {
    try {
      text = fs.readFileSync(input.path, "utf8");
    } catch {}
  }

  const artifact: Artifact = {
    id: rtId(),
    taskId: input.taskId,
    runId: input.runId,
    kind,
    title: input.title,
    path: input.path,
    text,
    url: input.url,
    mime,
    size,
    createdAt: Date.now(),
  };

  await withArtifacts((artifacts) => {
    artifacts.push(artifact);
  });
  return artifact;
}

export function listArtifacts(taskId?: string): Artifact[] {
  const all = loadArtifacts();
  const filtered = taskId ? all.filter((a) => a.taskId === taskId) : all;
  return filtered.sort((a, b) => b.createdAt - a.createdAt);
}

export function getArtifact(id: string): Artifact | null {
  return loadArtifacts().find((a) => a.id === id) ?? null;
}

export async function setKept(id: string, kept: boolean): Promise<Artifact | null> {
  let out: Artifact | null = null;
  await withArtifacts((artifacts) => {
    const a = artifacts.find((x) => x.id === id);
    if (a) {
      a.kept = kept;
      out = { ...a };
    }
  });
  return out;
}

export async function deleteArtifact(id: string, removeFile = false): Promise<boolean> {
  let removed: Artifact | undefined;
  await withArtifacts((artifacts) => {
    const i = artifacts.findIndex((a) => a.id === id);
    if (i !== -1) {
      removed = artifacts[i];
      artifacts.splice(i, 1);
    }
  });
  if (removed && removeFile && removed.path) {
    try {
      fs.rmSync(removed.path, { force: true });
    } catch {}
  }
  return !!removed;
}

/** Human-friendly size for the UI. */
export function fmtSize(n: number | undefined): string {
  if (n === undefined) return "";
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n > 1e3) return `${Math.ceil(n / 1e3)} KB`;
  return `${n} B`;
}

function guessMime(p: string): string | undefined {
  const ext = p.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    json: "application/json",
    csv: "text/csv",
    md: "text/markdown",
    txt: "text/plain",
    log: "text/plain",
    diff: "text/x-diff",
    patch: "text/x-diff",
    html: "text/html",
    pdf: "application/pdf",
  };
  return ext ? map[ext] : undefined;
}

export const artifactsDir = () => path.join(process.env.SWARM_HOME ?? "", "artifacts");