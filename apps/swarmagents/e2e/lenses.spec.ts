import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeBrowser, mode, openWorkspace, runPageTest, showChat, startNewChat } from "./lib";
import { FAKE_CLAUDE_ASSISTANT_TEXT } from "../lib/vm/fake-claude";

/**
 * The per-message lens menu (ELI5, mermaid architecture) was removed with the
 * minimal shell. A reply is still the conversation text. This spec checks that
 * path and that no lens menu is mounted.
 */

after(async () => {
  await closeBrowser();
});

test("lenses: ELI5 answer and a rendered mermaid architecture diagram", { skip: mode() === "prod" }, async (t) => {
  const result = await runPageTest("lenses: reply renders without a lens menu", async ({ page, context }) => {
    await openWorkspace(page, context);
    await startNewChat(page);
    const input = page.getByTestId("composer-input");
    await input.fill("Run a quick end-to-end smoke check.");
    await input.press("Enter");
    // The run plays on the screen on wide screens; the log only renders
    // in the chat view. Switch back and stay there: the active-run effect
    // re-opens the screen when the run starts, so a single click right
    // after the send can lose the race.
    await showChat(page);
    const log = page.getByTestId("conversation-log");
    await log.getByText(FAKE_CLAUDE_ASSISTANT_TEXT).first().waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.getByTestId("lens-menu").count(), 0);
    assert.equal(await page.locator("svg[data-testid='mermaid']").count(), 0);
    await page.waitForFunction(() => document.querySelector('[data-testid="run-indicator"]')?.getAttribute("data-phase") === "finished");
  });
  if (result.skipped) t.skip(result.skipped);
});
