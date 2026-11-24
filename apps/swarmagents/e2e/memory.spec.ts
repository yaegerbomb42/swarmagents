/**
 * Long-term memory (x2): the agent remembers a preference in one run and
 * recalls it in the next.
 *
 * Local mode only: the run itself needs the runtime. In prod mode the spec
 * is skipped, like the dispatch spec.
 *
 * The local fake VM replays a recorded transcript through the real runtime:
 * a prompt that asks the agent to remember something makes the fake agent
 * call the memory tool for real (the in-VM MCP server is emulated, the host
 * bridge and the account's store are not), and the next run starts with the
 * memory injected into the agent's system prompt.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { captureView, closeBrowser, mode, openWorkspace, runPageTest, showChat, startNewChat } from "./lib";
import { FAKE_CLAUDE_MEMORY_ASSISTANT_TEXT } from "../lib/vm/fake-claude";

after(async () => {
  await closeBrowser();
});

const readOnly = mode() === "prod";
const PREFERENCE = "I prefer pnpm over npm for package management";

test(
  "memory: a preference told in run 1 is recalled in run 2 and listed in Settings",
  { skip: readOnly ? "prod mode is read-only" : false },
  async (t) => {
    const testName = "memory: a preference told in run 1 is recalled in run 2 and listed in Settings";
    const result = await runPageTest(testName, async ({ page, context }) => {
      await openWorkspace(page, context);
      await startNewChat(page);

      // --- Run 1: the user tells the agent a preference. -----------------
      const input = page.getByTestId("composer-input");
      await input.fill(`remember this preference: ${PREFERENCE}`);
      await input.press("Enter");

      // The run plays on the screen on wide screens; the log only renders
      // in the chat view. Switch back and stay there: the active-run effect
      // re-opens the screen when the run starts, so a single click right
      // after the send can lose the race.
      await showChat(page);
      const log = page.getByTestId("conversation-log");
      await log.getByText(FAKE_CLAUDE_MEMORY_ASSISTANT_TEXT).first().waitFor({ state: "visible", timeout: 30_000 });
      await page.waitForFunction(() => document.querySelector('[data-testid="run-indicator"]')?.getAttribute("data-phase") === "finished");
      await captureView(page, testName, "run1-stored");

      // --- The memory is listed in the settings screen. -------------------
      await page.getByRole("button", { name: /^(Open )?[Ss]ettings$/ }).first().click();
      await page.getByRole("tab", { name: /memory/i }).first().click();
      const panel = page.getByTestId("memory-panel");
      await panel.waitFor({ state: "visible", timeout: 15_000 });

      const row = page.getByTestId("memory-row").first();
      await row.waitFor({ state: "visible", timeout: 20_000 });
      assert.match(await row.innerText(), /pnpm/);
      await captureView(page, testName, "settings-memory");

      // --- Searching narrows the list. -----------------------------------
      await page.getByTestId("memory-search").fill("quantum chromodynamics");
      await page.getByTestId("memory-empty").first().waitFor({ state: "visible", timeout: 20_000 });
      await page.getByTestId("memory-search").fill("pnpm");
      await row.waitFor({ state: "visible", timeout: 20_000 });

      // --- Close the settings, run again: the agent recalls it. ----------
      await page.keyboard.press("Escape");
      await page.getByTestId("settings-sheet").waitFor({ state: "hidden", timeout: 10_000 });

      await page.getByTestId("composer-input").fill("Which package manager should I use?");
      await page.getByTestId("composer-input").press("Enter");
      // The second run also opens the screen; switch back and stay on the
      // chat so the recalled reply is visible (a single click can lose to
      // the active-run effect).
      await showChat(page);
      // The screen keeps the run's narration mounted (hidden) while the chat
      // is shown, so a page-wide match can resolve to that hidden copy
      // first; scope to the log and take the rendered message.
      await page
        .getByTestId("conversation-log")
        .getByText(/I remember: .*pnpm/)
        .last()
        .waitFor({ state: "visible", timeout: 30_000 });
      await page.waitForFunction(() => document.querySelector('[data-testid="run-indicator"]')?.getAttribute("data-phase") === "finished");
      await captureView(page, testName, "run2-recalled");

      // --- The memory can be forgotten from the settings screen. ----------
      await page.getByRole("button", { name: /^(Open )?[Ss]ettings$/ }).first().click();
      await page.getByRole("tab", { name: /memory/i }).first().click();
      await panel.waitFor({ state: "visible", timeout: 15_000 });
      const deleteButton = page.getByTestId("memory-delete").first();
      await deleteButton.waitFor({ state: "visible", timeout: 20_000 });
      await deleteButton.click();
      await page.getByTestId("memory-empty").first().waitFor({ state: "visible", timeout: 20_000 });
      await captureView(page, testName, "settings-cleared");
    });
    if (result.skipped) t.skip(result.skipped);
  },
);
