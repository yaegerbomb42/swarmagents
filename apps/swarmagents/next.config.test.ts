import { test } from "node:test";
import assert from "node:assert/strict";
import nextConfig from "./next.config";

test("nextConfig.headers marks /login and auth/health endpoints as no-store", async () => {
  assert.equal(typeof nextConfig.headers, "function");
  const rules = await nextConfig.headers!();
  for (const path of ["/login", "/api/login", "/api/signup", "/api/me", "/api/health"]) {
    const rule = rules.find((r) => r.source === path);
    assert.ok(rule, `expected no-store header rule for ${path}`);
    const cacheControl = rule.headers.find((h) => h.key.toLowerCase() === "cache-control")?.value ?? "";
    const pragma = rule.headers.find((h) => h.key.toLowerCase() === "pragma")?.value ?? "";
    assert.ok(cacheControl.includes("no-store"), `${path} Cache-Control must include no-store`);
    assert.ok(!cacheControl.includes("31536000"), `${path} must never include year-long s-maxage`);
    assert.equal(pragma, "no-cache");
  }
});
