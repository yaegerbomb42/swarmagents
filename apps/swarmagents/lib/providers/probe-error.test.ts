/**
 * Tests for classifyProbeError: the mapping from typed provider failures
 * (and raw fetch failures) to the four coarse classes the UI renders.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { AbortError, ProviderError, classifyProbeError } from "./errors";
import type { ProviderErrorKind } from "./types";

function providerError(kind: ProviderErrorKind, status?: number): ProviderError {
  return new ProviderError(`synthetic ${kind}`, {
    provider: "test-provider",
    kind,
    retryable: false,
    ...(status !== undefined ? { status } : {}),
  });
}

test("auth failures classify as auth, keeping kind and status", () => {
  assert.deepEqual(classifyProbeError(providerError("auth", 401)), {
    errorClass: "auth",
    kind: "auth",
    status: 401,
  });
  assert.equal(classifyProbeError(providerError("auth", 403)).errorClass, "auth");
});

test("rate limits and exhausted quota classify as rate-limit", () => {
  assert.equal(classifyProbeError(providerError("rate_limit", 429)).errorClass, "rate-limit");
  assert.equal(classifyProbeError(providerError("quota_exhausted", 402)).errorClass, "rate-limit");
});

test("network, timeout and server failures classify as network", () => {
  assert.equal(classifyProbeError(providerError("network")).errorClass, "network");
  assert.equal(classifyProbeError(providerError("timeout", 408)).errorClass, "network");
  assert.equal(classifyProbeError(providerError("server", 503)).errorClass, "network");
});

test("other provider kinds classify as unknown but keep the kind", () => {
  for (const kind of ["bad_request", "invalid_response", "budget_exhausted", "aborted", "unknown"] as const) {
    const info = classifyProbeError(providerError(kind, 400));
    assert.equal(info.errorClass, "unknown", kind);
    assert.equal(info.kind, kind);
    assert.equal(info.status, 400);
  }
});

test("raw fetch failures classify as network", () => {
  assert.deepEqual(classifyProbeError(new TypeError("fetch failed")), { errorClass: "network" });
  assert.deepEqual(classifyProbeError(new AbortError()), { errorClass: "network" });
  const domAbort = new Error("The operation was aborted");
  domAbort.name = "AbortError";
  assert.deepEqual(classifyProbeError(domAbort), { errorClass: "network" });
});

test("anything else classifies as unknown", () => {
  assert.deepEqual(classifyProbeError(new Error("mystery")), { errorClass: "unknown" });
  assert.deepEqual(classifyProbeError("a string"), { errorClass: "unknown" });
  assert.deepEqual(classifyProbeError(undefined), { errorClass: "unknown" });
  assert.deepEqual(classifyProbeError(null), { errorClass: "unknown" });
});
