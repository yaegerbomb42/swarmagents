import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeBrowser, openWorkspace, runPageTest } from "./lib";

after(async () => {
  await closeBrowser();
});

test("views: terminal and browser views switch; secondary panels live in the settings drawer", async (t) => {
  const result = await runPageTest("views: terminal and browser", async ({ page, context }) => {
    await openWorkspace(page, context);
    await page.getByTestId("view-screen").click();
    await page.getByTestId("screen-frame").waitFor({ state: "visible", timeout: 15_000 });

    const views = page.getByRole("tablist", { name: "Computer views" });
    await views.getByRole("tab", { name: "Terminal" }).click();
    await views.getByRole("tab", { name: "Browser" }).click();
    await page.getByTestId("screen-frame").waitFor({ state: "visible" });

    // Files, plan, codebase and preview panels are not in this shell.
    // Providers, the agent, computers and memory live in Settings.
    await page.getByTestId("open-settings").click();
    const sheet = page.getByTestId("settings-sheet");
    await sheet.waitFor({ state: "visible" });
    for (const name of ["providers", "agent", "computers", "memory"]) {
      await page.getByTestId(`settings-tab-${name}`).click();
      assert.equal(await page.getByTestId(`settings-tab-${name}`).getAttribute("aria-selected"), "true");
    }
    assert.equal(await page.getByTestId("right-drawer").count(), 0);
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "hidden", timeout: 10_000 });
  });
  if (result.skipped) t.skip(result.skipped);
});
