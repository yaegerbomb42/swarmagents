import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeBrowser, mode, openWorkspace, runPageTest } from "./lib";
import { FAKE_CLAUDE_ASSISTANT_TEXT } from "../lib/vm/fake-claude";

/**
 * The template gallery was removed. A run still starts from the composer, and
 * standing instructions (the replacement for a saved prompt) are on the Agent tab.
 */

after(async () => {
  await closeBrowser();
});

const skip = mode() === "prod" ? "prod mode is read-only" : false;

test("templates: standing instructions are in Agent settings, and a composer run still completes", { skip }, async (t) => {
  const result = await runPageTest("templates: composer run", async ({ page, context }) => {
    await openWorkspace(page, context);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("settings-tab-agent").click();
    await page.getByTestId("agent-instructions").waitFor({ state: "visible" });
    assert.equal(await page.getByRole("button", { name: /Templates/ }).count(), 0);
    await page.keyboard.press("Escape");
    const input = page.getByTestId("composer-input");
    await input.fill("Run a quick end-to-end smoke check.");
    await input.press("Enter");
    await page.getByTestId("conversation-log").getByText(FAKE_CLAUDE_ASSISTANT_TEXT).first().waitFor({ state: "visible", timeout: 30_000 });
  });
  if (result.skipped) t.skip(result.skipped);
});
