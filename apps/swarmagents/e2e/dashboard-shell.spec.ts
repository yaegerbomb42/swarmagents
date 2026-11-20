import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeBrowser, mode, openWorkspace, runPageTest } from "./lib";

after(async () => {
  await closeBrowser();
});

const readOnly = mode() === "prod";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

test(
  "dashboard shell: settings drawer hosts threads, panels and workspace controls",
  { skip: readOnly ? "prod mode is read-only" : false },
  async (t) => {
    const result = await runPageTest(
      "dashboard shell: settings and history",
      async ({ page, context }) => {
        await openWorkspace(page, context);
        await page.getByTestId("open-history").click();
        await page.getByTestId("history-panel").waitFor({ state: "visible", timeout: 10_000 });
        await page.keyboard.press("Escape");
        await page.getByTestId("history-panel").waitFor({ state: "hidden", timeout: 10_000 });

        await page.getByTestId("open-settings").click();
        const sheet = page.getByTestId("settings-sheet");
        await sheet.waitFor({ state: "visible" });
        await page.getByTestId("settings-tab-providers").click();
        await page.getByText("Providers").first().waitFor({ state: "visible" });
        await page.getByTestId("settings-tab-agent").click();
        await page.getByTestId("agent-settings").waitFor({ state: "visible" });
        await page.getByTestId("settings-tab-computers").click();
        await page.getByTestId("computers-settings").waitFor({ state: "visible" });
        await page.getByTestId("settings-tab-memory").click();
        await page.getByTestId("memory-panel").waitFor({ state: "visible" });
        assert.equal(await page.getByTestId("right-drawer").count(), 0);
        assert.equal(await page.getByTestId("team-panel").count(), 0);
        await page.keyboard.press("Escape");
      },
      { viewport: DESKTOP },
    );
    if (result.skipped) t.skip(result.skipped);
  },
);

test(
  "dashboard shell: phone keeps the composer inside the viewport",
  { skip: readOnly ? "prod mode is read-only" : false },
  async (t) => {
    const result = await runPageTest(
      "dashboard shell: phone",
      async ({ page, context }) => {
        await openWorkspace(page, context);
        const box = await page.getByTestId("composer-input").boundingBox();
        assert.ok(box && box.y + box.height <= PHONE.height + 1);
        const horizontal = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        );
        assert.equal(horizontal, false);
      },
      { viewport: PHONE },
    );
    if (result.skipped) t.skip(result.skipped);
  },
);
