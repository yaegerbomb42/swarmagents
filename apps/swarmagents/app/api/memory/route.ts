/**
 * The account's long-term memory (REST view).
 *
 * GET    /api/memory[?q=&tag=&k=]  list or search the account's memories
 * POST   /api/memory                store one memory
 * DELETE /api/memory                forget every memory ("Clear all")
 *
 * The store lives in the app's per-user data directory (never inside the
 * VM), so the memories outlive a VM reset. Every request is scoped to the
 * signed-in account: one account can never read or delete another account's
 * memories.
 */

import { NextResponse, type NextRequest } from "next/server";
import { providerOwner } from "@/lib/providers/owner";
import { JsonBodyError, readJsonBody } from "@/lib/http";
import { clearMemories, listMemories, searchMemories, writeMemory } from "@/lib/memory/store";
import { publicFact } from "@/lib/memory/tools";
import { MAX_SEARCH_K } from "@/lib/memory/types";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

function unauthorized() {
  return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
}

export async function GET(request: NextRequest) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();

  try {
    const params = request.nextUrl.searchParams;
    const query = (params.get("q") ?? params.get("query") ?? "").trim();
    const tag = (params.get("tag") ?? "").trim();
    const rawK = Number(params.get("k"));
    const k = Number.isFinite(rawK) && rawK > 0 ? Math.min(Math.floor(rawK), MAX_SEARCH_K) : undefined;

    if (!query && !tag) {
      const memories = listMemories(owner).map(publicFact);
      return NextResponse.json({ memories, total: memories.length }, { headers: NO_STORE });
    }

    const memories = (await searchMemories(owner, query, { k, tag: tag || undefined })).map((memory) => ({
      id: memory.id,
      fact: memory.fact,
      tags: memory.tags,
      score: memory.score,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    }));
    return NextResponse.json({ memories, total: memories.length }, { headers: NO_STORE });
  } catch {
    // Reads are fail-safe in the store, so this guards a future store or
    // embedder failure — never let its detail reach the client.
    return NextResponse.json({ error: "Memory is temporarily unavailable." }, { status: 503, headers: NO_STORE });
  }
}

export async function POST(request: NextRequest) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (err) {
    if (err instanceof JsonBodyError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: NO_STORE });
    }
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: NO_STORE });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400, headers: NO_STORE });
  }
  const input = body as Record<string, unknown>;
  if (typeof input.fact !== "string" || input.fact.trim() === "") {
    return NextResponse.json({ error: "fact must be a non-empty string." }, { status: 400, headers: NO_STORE });
  }

  try {
    const memory = await writeMemory(owner, { fact: input.fact, tags: input.tags });
    return NextResponse.json({ memory: publicFact(memory) }, { status: 201, headers: NO_STORE });
  } catch {
    // Validation already ran above, so anything thrown here is a storage
    // failure — never surface its message (filesystem paths, errno text).
    return NextResponse.json({ error: "Could not store memory." }, { status: 500, headers: NO_STORE });
  }
}

export async function DELETE(request: NextRequest) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();
  try {
    const forgotten = clearMemories(owner);
    return NextResponse.json({ forgotten }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Could not clear memories." }, { status: 500, headers: NO_STORE });
  }
}
