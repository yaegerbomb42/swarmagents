import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeBrowser, mode, openWorkspace, runPageTest } from "./lib";

/**
 * Role presets and the agent-card modal were removed. Standing instructions
 * are the Agent tab textarea.
 */

after(async () => {
  await closeBrowser();
});

const skip = mode() === "prod" ? "prod mode is read-only" : false;

test("roles: the agent card is edited from settings and kept", { skip }, async (t) => {
  const result = await runPageTest("roles: standing instructions", async ({ page, context }) => {
    await openWorkspace(page, context);
    assert.equal(await page.locator("select[aria-label='Role']").count(), 0);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("settings-tab-agent").click();
    const card = page.getByTestId("agent-instructions");
    await card.waitFor({ state: "visible" });
    const note = `e2e-instructions-${Date.now().toString(36)}`;
    await card.fill(note);
    await page.keyboard.press("Escape");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("composer-input").waitFor({ state: "visible" });
    await page.getByTestId("open-settings").click();
    await page.getByTestId("settings-tab-agent").click();
    assert.equal(await page.getByTestId("agent-instructions").inputValue(), note);
  });
  if (result.skipped) t.skip(result.skipped);
});
