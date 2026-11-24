import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeBrowser, mode, openWorkspace, runPageTest } from "./lib";

/**
 * Team lanes (merge counts, take-over-a-lane) were removed with the minimal
 * shell. Coordinating work is the board: file a task and see it listed.
 */

after(async () => {
  await closeBrowser();
});

const skip = mode() === "prod" ? "prod mode is read-only" : false;

test("team: a task filed on the board is the coordination surface", { skip }, async (t) => {
  const result = await runPageTest("team: board task", async ({ page, context }) => {
    await openWorkspace(page, context, { devMode: true });
    assert.equal(await page.getByTestId("team-panel").count(), 0);
    assert.equal(await page.getByTestId("team-mode-toggle").count(), 0);
    await page.getByTestId("view-board").click();
    const title = `e2e-board-${Date.now().toString(36)}`;
    await page.getByTestId("board-add-input").fill(title);
    await page.getByTestId("board-add-submit").click();
    await page.getByTestId("board-panel").getByText(title).waitFor({ state: "visible", timeout: 15_000 });
  });
  if (result.skipped) t.skip(result.skipped);
});
