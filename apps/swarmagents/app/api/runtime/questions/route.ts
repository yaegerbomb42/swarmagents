/**
 * ask_user question endpoint (minimal main page).
 *
 * GET  ?runId=<id>&pending=1 -> the caller's unanswered questions, so a page
 *      reload still renders the inline question card and can answer it.
 * POST {id, answer}          -> answers a pending question; the run resumes
 *      and the answer is returned to the agent as the ask_user tool result.
 *
 * Auth comes from the middleware-set x-swarm-user header (see lib/auth); the
 * caller must own the question (same user as the paused run).
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import { getQuestionStore, type PendingQuestion } from "../../../../lib/harness/questions";
import { recordAudit } from "../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 32 * 1024;
const MAX_ANSWER_LEN = 4000;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unauthorized() {
  return NextResponse.json({ error: "Sign in required." }, { status: 401 });
}

function publicQuestion(question: PendingQuestion) {
  return {
    id: question.id,
    runId: question.runId,
    question: question.question,
    options: question.options,
    allowFreeText: question.allowFreeText,
    createdAt: question.createdAt,
    expiresAt: question.expiresAt,
  };
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();
  const params = new URL(req.url).searchParams;
  const runId = params.get("runId") ?? undefined;
  const questions = getQuestionStore()
    .listPending({ userId: user, ...(runId ? { runId } : {}) })
    .map(publicQuestion);
  return NextResponse.json({ questions });
}

export async function POST(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();

  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ error: "Could not read request body." }, { status: 400 });
  }
  if (text.length > MAX_BODY_SIZE) {
    return NextResponse.json({ error: "Request body too large." }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  if (!answer) return NextResponse.json({ error: "answer is required." }, { status: 400 });
  if (answer.length > MAX_ANSWER_LEN) {
    return NextResponse.json({ error: "answer too long." }, { status: 400 });
  }

  const store = getQuestionStore();
  const question = store.get(id);
  if (!question || question.userId !== user) {
    return NextResponse.json({ error: "Question not found." }, { status: 404 });
  }
  if (question.status !== "pending") {
    return NextResponse.json(
      { error: `Question already ${question.status}.`, status: question.status },
      { status: 409 },
    );
  }

  const answered = store.answer(id, answer);
  recordAudit({ user, action: "question.answer", target: id, result: "success" });
  return NextResponse.json({ ok: true, status: answered?.status ?? "answered" });
}
