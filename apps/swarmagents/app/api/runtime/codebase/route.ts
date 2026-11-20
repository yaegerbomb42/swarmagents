/**
 * The codebase map API.
 *
 * GET  /api/runtime/codebase?repo=<path>&n=50   -> the map of that repository
 * GET  /api/runtime/codebase?list=1              -> the repositories in the workspace
 * POST /api/runtime/codebase { "repo": "<path>" } -> rebuild the map now
 *
 * The repository lives in the caller's own VM, so the map is built there and
 * stored under `~/.swarm/codebase/<repoHash>/` inside that VM. Everything is
 * scoped to the caller: the route only ever touches the VM of the account in
 * the `x-swarm-user` header.
 */

import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import { getVmManager, type VmManager } from "../../../../lib/vm/manager";
import { resolveWorkspacePath, VmPathError } from "../../../../lib/vm/files";
import {
  ensureCodebaseMap,
  listCodebaseRepos,
  selectCodebaseRepo,
  selectedCodebaseRepo,
} from "../../../../lib/codebase/store";
import { createVmScanner } from "../../../../lib/codebase/vm-scanner";
import { createLocalScanner } from "../../../../lib/codebase/local-scanner";
import type { CodebaseMap, CodebaseScanner } from "../../../../lib/codebase/types";
import { JsonBodyError, readJsonBody } from "../../../../lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

/** The summary the UI renders (the map itself is far too big to send). */
function summarize(map: CodebaseMap, hotspots: number) {
  return {
    repoRoot: map.repoRoot,
    repoName: map.repoName,
    repoHash: map.repoHash,
    generatedAt: map.generatedAt,
    gitHead: map.gitHead,
    buildMs: map.buildMs,
    fileCount: map.files.length,
    tokenEstimate: map.contextPack.tokenEstimate,
    languages: map.languages,
    entryPoints: map.entryPoints,
    buildCommands: map.buildCommands,
    testCommands: map.testCommands,
    conventions: map.conventions,
    topLevelModules: map.topLevelModules,
    heatmap: map.heatmap.slice(0, hotspots),
    contextPack: { tokenEstimate: map.contextPack.tokenEstimate, text: map.contextPack.text },
  };
}

/**
 * Local development / e2e hook. When `SWARM_CODEBASE_LOCAL_ROOT` names a
 * checkout on the app server's own filesystem, the map is built from that
 * checkout with the same analyzer the VM runs. It is unset in production,
 * where the repository exists only inside the caller's VM.
 */
function localRoot(): string | null {
  const configured = process.env.SWARM_CODEBASE_LOCAL_ROOT?.trim();
  return configured ? path.resolve(configured) : null;
}

/** The scanner the route uses: the caller's VM, or a local checkout in dev. */
function scannerFor(vm: VmManager, local: string | null): CodebaseScanner {
  return local ? createLocalScanner() : createVmScanner(vm);
}

/**
 * The repository root the caller asked for (always inside the workspace).
 * In local mode the request is resolved against the configured checkout and
 * may never escape it.
 */
function repoRootFrom(raw: string | null, local: string | null): string {
  if (!local) return resolveWorkspacePath(raw ?? "");
  const requested = (raw ?? "").trim();
  if (!requested) return local;
  const resolved = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(local, requested);
  if (resolved === local || resolved.startsWith(`${local}${path.sep}`)) return resolved;
  throw new VmPathError("outside_workspace", "Path is outside the local codebase root.");
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const params = req.nextUrl.searchParams;
  const vm = getVmManager();
  const local = localRoot();
  const scanner = scannerFor(vm, local);

  if (params.get("list") === "1" || params.get("list") === "true") {
    if (local) {
      // In local mode the checkout itself is the only pickable repository.
      const stored = await selectedCodebaseRepo(user, scanner).catch(() => null);
      const selected = stored && (stored === local || stored.startsWith(`${local}${path.sep}`)) ? stored : null;
      return NextResponse.json({
        ok: true,
        repos: [{ repo: "", repoRoot: local, name: path.basename(local) || "checkout" }],
        selected,
      });
    }
    const repos = await listCodebaseRepos(user, scanner);
    const selected = await selectedCodebaseRepo(user, scanner);
    return NextResponse.json({ ok: true, repos, selected });
  }

  const rawN = Number(params.get("n") ?? "");
  const n = Number.isFinite(rawN) && rawN > 0 ? Math.min(200, Math.floor(rawN)) : 50;

  try {
    const repoRoot = repoRootFrom(params.get("repo"), local);

    // `ensureCodebaseMap` reads the published map back first and rebuilds it
    // only when the repository's HEAD moved, so polling this route is cheap.
    const map = await ensureCodebaseMap(user, scanner, { repoRoot });
    if (!map) {
      // No map yet is a normal state (the repository was never picked), not an
      // error: the UI asks for one.
      return NextResponse.json({
        ok: true,
        map: null,
        repoRoot,
        error: "No codebase map for this repository yet.",
      });
    }
    return NextResponse.json({ ok: true, map: summarize(map, n) });
  } catch (error) {
    const status = error instanceof VmPathError ? 400 : 500;
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(req: NextRequest) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  let repo: string | null = null;
  let force = false;
  try {
    // A malformed body still falls back to "no repo picked", as before —
    // only an oversized body is now refused instead of parsed unbounded.
    const body = (await readJsonBody(req)) as { repo?: unknown; force?: unknown };
    if (typeof body.repo === "string") repo = body.repo;
    force = body.force === true;
  } catch (err) {
    if (err instanceof JsonBodyError && err.status === 413) {
      return NextResponse.json({ error: err.message }, { status: 413 });
    }
    repo = null;
  }

  const local = localRoot();
  const vm = getVmManager();
  const scanner = scannerFor(vm, local);

  try {
    const repoRoot = repoRootFrom(repo, local);
    const map = await ensureCodebaseMap(user, scanner, { repoRoot, force });
    if (!map) {
      return NextResponse.json(
        { error: "Could not build a codebase map for that repository.", repoRoot },
        { status: 500 },
      );
    }
    // Picking a repository is what makes its pack part of every run.
    await selectCodebaseRepo(user, scanner, map.repoRoot);
    return NextResponse.json({ ok: true, map: summarize(map, 50) });
  } catch (error) {
    const status = error instanceof VmPathError ? 400 : 500;
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status });
  }
}
