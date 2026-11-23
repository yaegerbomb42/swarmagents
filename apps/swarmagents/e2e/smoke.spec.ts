import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeBrowser, openWorkspace, runPageTest } from "./lib";

after(async () => {
  await closeBrowser();
});

test("smoke: API health and swarm-board", async () => {
  await runPageTest("smoke: API health and swarm-board", async ({ context }) => {
    const board = await context.request.get("/api/mcp/swarm-board");
    assert.ok(board.ok(), `swarm-board returned HTTP ${board.status()}`);
    const boardJson = (await board.json()) as { name?: string; counts?: unknown };
    assert.equal(boardJson.name, "swarm-board", "expected swarm-board JSON payload");
    assert.ok(boardJson.counts && typeof boardJson.counts === "object", "expected board counts in JSON");

    const health = await context.request.get("/api/health");
    if (health.status() !== 404) {
      assert.ok(health.ok(), `health endpoint returned HTTP ${health.status()}`);
    }
  });
});

test("smoke: home UI workspace", async (t) => {
  const result = await runPageTest("smoke: home UI workspace", async ({ page, context, consoleErrors }) => {
    await openWorkspace(page, context, { devMode: true });

    const input = page.locator("textarea").first();
    assert.equal(await input.isVisible(), true, "expected the prompt input bar to be visible");

    // Idle workspace: composer and the three view controls. The screen mounts when a run starts.
    await page.getByTestId("composer").waitFor({ state: "visible", timeout: 15_000 });
    await page.getByTestId("view-chat").waitFor({ state: "visible", timeout: 15_000 });
    await page.getByTestId("view-screen").waitFor({ state: "visible", timeout: 15_000 });
    await page.getByTestId("view-board").waitFor({ state: "visible", timeout: 15_000 });
    await page.getByTestId("open-settings").waitFor({ state: "visible", timeout: 15_000 });

    assert.deepEqual(consoleErrors, [], `unexpected page errors: ${consoleErrors.join(" | ")}`);
  });
  if (result.skipped) t.skip(result.skipped);
});

test("smoke: hardened security headers on document responses", async () => {
  await runPageTest("smoke: hardened security headers on document responses", async ({ context }) => {
    const res = await context.request.get("/");
    assert.ok(res.ok(), `home page returned HTTP ${res.status()}`);
    const h = res.headers();
    const csp = h["content-security-policy"] ?? "";

    assert.match(csp, /nonce-/, "expected a nonce-based Content-Security-Policy");
    assert.match(csp, /frame-ancestors 'none'/, "expected frame-ancestors 'none'");
    assert.match(csp, /\bscript-src\b/, "expected a script-src directive");
    assert.ok(
      !/\bscript-src\b[^;]*'unsafe-inline'/.test(csp),
      "inline scripts must only be permitted via the nonce",
    );
    assert.equal(h["x-content-type-options"], "nosniff", "expected X-Content-Type-Options: nosniff");
    assert.equal(h["x-frame-options"], "DENY", "expected X-Frame-Options: DENY");
    assert.ok(h["referrer-policy"], "expected Referrer-Policy");
    assert.ok(h["permissions-policy"], "expected Permissions-Policy");
  });
});
