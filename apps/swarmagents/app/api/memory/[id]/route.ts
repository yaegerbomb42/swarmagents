/**
 * One memory of the signed-in account.
 *
 * GET    /api/memory/[id]  one memory
 * DELETE /api/memory/[id]  forget one memory
 *
 * The id is looked up inside the account's own store, so an id from another
 * account is simply not found.
 */

import { NextResponse, type NextRequest } from "next/server";
import { providerOwner } from "@/lib/providers/owner";
import { forgetMemory, getMemory } from "@/lib/memory/store";
import { publicFact } from "@/lib/memory/tools";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;
const MEMORY_ID_RE = /^mem_[a-f0-9-]{8,64}$/i;

function isMemoryId(value: unknown): value is string {
  return typeof value === "string" && MEMORY_ID_RE.test(value);
}

function unauthorized() {
  return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();
  const { id } = await context.params;
  if (!isMemoryId(id)) {
    return NextResponse.json({ error: "Memory not found." }, { status: 404, headers: NO_STORE });
  }
  const memory = getMemory(owner, id);
  if (!memory) {
    return NextResponse.json({ error: "Memory not found." }, { status: 404, headers: NO_STORE });
  }
  return NextResponse.json({ memory: publicFact(memory) }, { headers: NO_STORE });
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();
  const { id } = await context.params;
  if (!isMemoryId(id)) {
    return NextResponse.json({ error: "Memory not found." }, { status: 404, headers: NO_STORE });
  }
  const forgotten = forgetMemory(owner, id) ? 1 : 0;
  if (forgotten === 0) {
    return NextResponse.json({ error: "Memory not found." }, { status: 404, headers: NO_STORE });
  }
  return NextResponse.json({ forgotten }, { headers: NO_STORE });
}
