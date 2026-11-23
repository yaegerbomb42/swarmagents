/**
 * POST /api/runtime/auto-test — generate and run a verification test for
 * one function in the caller's VM workspace (see lib/harness/auto-test.ts).
 *
 * Body: { filePath, functionName, startLine?, endLine? }
 * Reply: the TestGenResult ({ success, testFilePath, testPassed, output }).
 * A failed pipeline is still a 200 — the result object is the reply.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import { recordAudit } from "../../../../lib/audit";
import {
  autoTestDepsFor,
  generateAndRunVerificationTest,
} from "../../../../lib/harness/auto-test";
import { noStoreJson, readJsonObject } from "../../../../lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PATH_LENGTH = 512;
const MAX_FUNCTION_NAME_LENGTH = 128;
const FUNCTION_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// One auto-test per user at a time: each call spends an LLM completion and
// three VM execs, and two concurrent calls for the same target would race
// on the same temp test file.
const inFlight = new Set<string>();

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

/** undefined = absent, null = present but invalid. */
function positiveInt(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Middleware clears any client-supplied value and sets the authenticated id.
  const userId = caller(req);
  if (!userId) return noStoreJson({ error: "Sign in required." }, { status: 401 });

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const { filePath, functionName, startLine, endLine } = parsed.value;

  if (typeof filePath !== "string" || !filePath.trim() || filePath.length > MAX_PATH_LENGTH) {
    return noStoreJson(
      { error: `filePath must be a string of 1–${MAX_PATH_LENGTH} characters.` },
      { status: 400 },
    );
  }
  if (
    typeof functionName !== "string" ||
    functionName.length > MAX_FUNCTION_NAME_LENGTH ||
    !FUNCTION_NAME_RE.test(functionName)
  ) {
    return noStoreJson(
      { error: "functionName must be a valid JavaScript identifier." },
      { status: 400 },
    );
  }
  const start = positiveInt(startLine);
  const end = positiveInt(endLine);
  if (start === null) {
    return noStoreJson({ error: "startLine must be a positive integer." }, { status: 400 });
  }
  if (end === null) {
    return noStoreJson({ error: "endLine must be a positive integer." }, { status: 400 });
  }
  if (start !== undefined && end !== undefined && start > end) {
    return noStoreJson({ error: "startLine must be <= endLine." }, { status: 400 });
  }

  if (inFlight.has(userId)) {
    return noStoreJson(
      { error: "An auto-test is already in progress for this account." },
      { status: 409 },
    );
  }
  inFlight.add(userId);
  try {
    const result = await generateAndRunVerificationTest(userId, autoTestDepsFor(), {
      filePath,
      functionName,
      ...(start !== undefined ? { startLine: start } : {}),
      ...(end !== undefined ? { endLine: end } : {}),
    });
    recordAudit({
      user: userId,
      action: "auto-test.run",
      target: result.testFilePath || filePath,
      result: result.success ? "success" : "failure",
    });
    return noStoreJson(result);
  } finally {
    inFlight.delete(userId);
  }
}
