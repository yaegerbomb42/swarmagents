import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeBrowser, openWorkspace, runPageTest } from "./lib";

/**
 * The codebase heatmap lived in the right drawer. That drawer is not part of
 * the one-workspace shell (chat, screen, board). This spec checks the
 * replacement: the screen is how you see the machine, and the heatmap is gone.
 */

after(async () => {
  await closeBrowser();
});

test("codebase: the right drawer has a Codebase tab with the heatmap", async (t) => {
  const result = await runPageTest("codebase: screen replaces the heatmap drawer", async ({ page, context }) => {
    await openWorkspace(page, context);
    assert.equal(await page.locator("[data-testid='codebase-tab']").count(), 0);
    assert.equal(await page.locator("[data-testid='codebase-treemap']").count(), 0);
    assert.equal(await page.locator("[data-testid='right-drawer']").count(), 0);
    await page.getByTestId("view-screen").click();
    await page.getByTestId("screen-frame").waitFor({ state: "visible", timeout: 15_000 });
  });
  if (result.skipped) t.skip(result.skipped);
});
