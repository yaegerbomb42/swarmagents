import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeBrowser, openWorkspace, runPageTest } from "./lib";

after(async () => {
  await closeBrowser();
});

// A common mid-range phone viewport. Asserting at exactly the acceptance size
// (390x844) keeps the spec honest about the mobile-first layout.
const PHONE_VIEWPORT = { width: 390, height: 844 };

test("mobile: 390x844 has no horizontal scroll and keeps the input visible", async (t) => {
  const result = await runPageTest(
    "mobile: workspace at 390x844",
    async ({ page, context }) => {
      await openWorkspace(page, context);

      // The workspace must not scroll horizontally at a phone width.
      const hasHorizontalScroll = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth;
      });
      assert.equal(hasHorizontalScroll, false, "page must not scroll horizontally at 390px");

      // The prompt input stays visible above the safe area.
      const input = page.locator("textarea").first();
      assert.equal(await input.isVisible(), true, "expected the prompt input bar to be visible");
      const inputBox = await input.boundingBox();
      assert.ok(inputBox && inputBox.height > 0, "expected the prompt input to have layout size");
      assert.ok(inputBox.y + inputBox.height <= PHONE_VIEWPORT.height + 1, "input must stay inside the viewport");

      // Idle phone: the composer and the view switcher. The screen opens with a run.
      await page.getByTestId("view-chat").waitFor({ state: "visible", timeout: 15_000 });
      await page.getByTestId("composer").waitFor({ state: "visible", timeout: 15_000 });
      assert.equal(await page.locator("[data-testid='mobile-tab-bar']").count(), 0);
      assert.equal(await page.locator("[data-testid='activity-strip']").count(), 0);
      assert.equal(await page.locator("nav[aria-label='View switcher']").count(), 0);

      // Settings slide in from the right-edge tab and close with Esc.
      await page.getByTestId("open-settings").click();
      await page.getByTestId("settings-sheet").waitFor({ state: "visible", timeout: 10_000 });
      await page.keyboard.press("Escape");
      await page.getByTestId("settings-sheet").waitFor({ state: "hidden", timeout: 10_000 });
    },
    { viewport: PHONE_VIEWPORT },
  );

  if (result.skipped) t.skip(result.skipped);
});
