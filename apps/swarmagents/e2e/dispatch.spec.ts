import { after, test } from "node:test";
import { captureView, closeBrowser, mode, openWorkspace, runPageTest, showChat, startNewChat } from "./lib";
import { FAKE_CLAUDE_ASSISTANT_TEXT } from "../lib/vm/fake-claude";

after(async () => {
  await closeBrowser();
});

const readOnly = mode() === "prod";

test(
  "dispatch: prompt streams conversation and tool narration into the log",
  { skip: readOnly ? "prod mode is read-only" : false },
  async (t) => {
    const testName = "dispatch: prompt streams log lines into the UI";
    const result = await runPageTest(testName, async ({ page, context }) => {
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
      // The local fake VM replays a recorded stream-json transcript through the
      // real runtime pipeline, so the conversation shows the user ask, the
      // agent's message, a readable tool line and the terminal status.
      const log = page.getByTestId("conversation-log");
      await log.getByText("Run a quick end-to-end smoke check.").first().waitFor({ state: "visible", timeout: 30_000 });
      await log.getByText(/Running: uname -a/).first().waitFor({ state: "visible", timeout: 15_000 });
      await captureView(page, testName, "running");
      await log.getByText(FAKE_CLAUDE_ASSISTANT_TEXT).first().waitFor({ state: "visible", timeout: 30_000 });
      await page.getByTestId("run-indicator").waitFor({ state: "visible", timeout: 45_000 });
      await page.waitForFunction(() => document.querySelector('[data-testid="run-indicator"]')?.getAttribute("data-phase") === "finished");
    });
    if (result.skipped) t.skip(result.skipped);
  },
);

test(
  "dispatch: the log streams on a phone viewport too",
  { skip: readOnly ? "prod mode is read-only" : false },
  async (t) => {
    const testName = "dispatch: mobile during-run log";
    const result = await runPageTest(
      testName,
      async ({ page, context }) => {
        await openWorkspace(page, context);
        await startNewChat(page);

        const input = page.getByTestId("composer-input");
        await input.fill("Run a quick end-to-end smoke check.");
        await input.press("Enter");

        // A phone stays on the chat (no auto-switch to the screen), so the
        // log is already visible; showChat returns at once there.
        await showChat(page);
        const log = page.getByTestId("conversation-log");
        await log.getByText(/Running: uname -a/).first().waitFor({ state: "visible", timeout: 30_000 });
        await captureView(page, testName, "running-mobile");
        await page.getByTestId("run-indicator").waitFor({ state: "visible", timeout: 45_000 });
      await page.waitForFunction(() => document.querySelector('[data-testid="run-indicator"]')?.getAttribute("data-phase") === "finished");
      },
      { viewport: { width: 390, height: 844 } },
    );
    if (result.skipped) t.skip(result.skipped);
  },
);
