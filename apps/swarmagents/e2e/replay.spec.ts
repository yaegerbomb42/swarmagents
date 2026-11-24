import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeBrowser, mode, openWorkspace, runPageTest, showChat, startNewChat, waitForLastTurn } from "./lib";
import { FAKE_CLAUDE_ASSISTANT_TEXT } from "../lib/vm/fake-claude";

/**
 * The run-replay scrubber was removed with the minimal shell. A finished run
 * is reopened from History.
 */

after(async () => {
  await closeBrowser();
});

test("replay: scrub, play and fork a finished event log", { skip: mode() === "prod" }, async (t) => {
  const result = await runPageTest("replay: history reopens a finished run", async ({ page, context }) => {
    await openWorkspace(page, context);
    await startNewChat(page);
    const input = page.getByTestId("composer-input");
    await input.fill("Run a quick end-to-end smoke check.");
    await input.press("Enter");
    // The run plays on the screen on wide screens; the log only renders
    // in the chat view. Switch back and stay there (see showChat in lib).
    await showChat(page);
    await page.getByTestId("conversation-log").getByText(FAKE_CLAUDE_ASSISTANT_TEXT).first().waitFor({ state: "visible", timeout: 30_000 });
    await waitForLastTurn(page, "finished");
    await page.getByTestId("open-history").click();
    await page.getByTestId("history-thread").first().waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await page.getByTestId("run-replay").count(), 0);
    assert.equal(await page.getByTestId("replay-scrubber").count(), 0);
  });
  if (result.skipped) t.skip(result.skipped);
});
