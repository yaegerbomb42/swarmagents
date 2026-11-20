/**
 * Unit tests for the client approval decision helper (lib/client/approvals.ts).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { approvalSecondsLeft, formatApprovalCountdown, postApprovalDecision } from "./approvals";

function fakeFetch(status: number, body: unknown, calls: Array<{ url: string; init: RequestInit }> = []) {
  return (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

test("approve posts the decision and returns ok with the store status", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = fakeFetch(200, { ok: true, status: "approved" }, calls);
  const result = await postApprovalDecision("appr_abc", "approve", fetch);

  assert.equal(result.ok, true);
  assert.equal(result.status, "approved");
  assert.equal(result.error, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/runtime/approvals/appr_abc");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { decision: "approve" });
});

test("deny posts the same endpoint with decision deny", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = fakeFetch(200, { ok: true, status: "denied" }, calls);
  const result = await postApprovalDecision("appr_abc", "deny", fetch);

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { decision: "deny" });
});

test("non-ok responses surface the API error message", async () => {
  const result = await postApprovalDecision("appr_abc", "approve", fakeFetch(409, { error: "Approval already approved." }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "Approval already approved.");
});

test("error responses without a JSON body fall back to a generic message", async () => {
  const fetchImpl = (async () => new Response("<html>oops</html>", { status: 500 })) as unknown as typeof fetch;
  const result = await postApprovalDecision("appr_abc", "approve", fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(result.error, "decision rejected (500)");
});

test("network failures become a failed decision instead of a throw", async () => {
  const fetchImpl = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const result = await postApprovalDecision("appr_abc", "approve", fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(result.error, "network down");
});

test("countdown helpers report seconds left and format m:ss", () => {
  assert.equal(approvalSecondsLeft(10_500, 10_000), 1);
  assert.equal(approvalSecondsLeft(10_000, 10_500), 0);
  assert.equal(approvalSecondsLeft(undefined, 10_000), undefined);
  assert.equal(formatApprovalCountdown(59), "59s");
  assert.equal(formatApprovalCountdown(60), "1:00");
  assert.equal(formatApprovalCountdown(125), "2:05");
  assert.equal(formatApprovalCountdown(0), "expired");
  assert.equal(formatApprovalCountdown(undefined), undefined);
});
