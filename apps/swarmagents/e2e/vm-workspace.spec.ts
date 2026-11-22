import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeBrowser, mode, runPageTest } from "./lib";

after(async () => { await closeBrowser(); });

test("composer stays above the computer while its views and chat switch", { skip: mode() === "prod" }, async (t) => {
  const result = await runPageTest("vm-workspace", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const composer = page.getByTestId("composer-input");
    await composer.waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("view-screen").click();
    const frame = page.getByTestId("screen-frame");
    await frame.waitFor({ state: "visible" });
    const composerBox = await composer.boundingBox();
    const frameBox = await frame.boundingBox();
    assert.ok(composerBox && frameBox && composerBox.y < frameBox.y);
    // The fake driver has no desktop. A desktop-enabled server also exercises
    // that tab, but this smoke test does not pretend to verify an RFB frame.
    const views = ["desktop", "terminal", "browser", "files"];
    for (const view of views) {
      const tab = page.getByTestId(`screen-view-${view}`);
      if (!(await tab.isVisible())) continue;
      await tab.click();
      assert.equal(await tab.getAttribute("aria-selected"), "true");
      assert.equal(await composer.isVisible(), true);
    }
    await page.getByTestId("view-chat").click();
    assert.equal(await frame.count(), 1, "computer stays mounted behind chat");
    assert.equal(await composer.isVisible(), true);
    await page.getByTestId("view-screen").click();
    assert.equal(await frame.isVisible(), true);
  });
  if (result.skipped) t.skip(result.skipped);
});
