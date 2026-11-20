/**
 * Public pairing endpoint used by the node on a user's computer.
 *
 * POST { code, machine? } -> { computer, nodeToken }
 *
 * The pairing code is the only credential here (the caller has no session yet),
 * so an invalid, expired or already-used code returns the same 404 — a caller
 * cannot probe which accounts or codes exist. The node token is returned in
 * clear exactly once; only its hash is stored. This path is in the middleware
 * public allow-list.
 */

import { NextResponse, type NextRequest } from "next/server";
import { ComputersError, redeemPairingCode } from "../../../../lib/computers";
import { recordAudit } from "../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;
const MAX_BODY_SIZE = 16 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(req: NextRequest) {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ error: "Could not read request body." }, { status: 400, headers: NO_STORE });
  }
  if (text.length > MAX_BODY_SIZE) {
    return NextResponse.json({ error: "Request body too large." }, { status: 413, headers: NO_STORE });
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: NO_STORE });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400, headers: NO_STORE });
  }

  const machine = isRecord(body.machine) ? body.machine : undefined;
  try {
    const result = redeemPairingCode(body.code, machine);
    if (!result) {
      return NextResponse.json(
        { error: "That pairing code is invalid or has expired." },
        { status: 404, headers: NO_STORE },
      );
    }
    // The pairing code itself is never logged; the owner and computer id
    // are the attributable identifiers. A failed redeem cannot be
    // attributed to an account, so it is deliberately not audited.
    recordAudit({ user: result.userId, action: "computer.pair", target: result.computer.id, result: "success" });
    return NextResponse.json(
      { computer: result.computer, nodeToken: result.nodeToken },
      { headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof ComputersError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: NO_STORE });
    }
    return NextResponse.json({ error: "Could not pair this computer." }, { status: 500, headers: NO_STORE });
  }
}
