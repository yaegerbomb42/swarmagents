import assert from "node:assert/strict";
import { after, test } from "node:test";
import { captureView, closeBrowser, mode, openWorkspace, runPageTest } from "./lib";
import { FAKE_CLAUDE_AUTO_APPROVE_COMMAND, FAKE_CLAUDE_AUTO_APPROVE_TRIGGER } from "../lib/vm/fake-claude";

after(async () => {
  await closeBrowser();
});

const readOnly = mode() === "prod";

// The fake VM selects its routine ask-classified transcript when the prompt
// contains this phrase. In auto-approve mode the risk gate must let it run
// without ever asking the user, while the VM-only policy still runs
// server-side. (Irreversible actions such as deleting the sandbox root stay
// gated even in full-auto mode.)
const RISKY_PROMPT = `Please ${FAKE_CLAUDE_AUTO_APPROVE_TRIGGER} so we can keep going.`;

test(
  "auto-approve: an ask-classified call runs without any approval card",
  { skip: readOnly ? "prod mode is read-only" : false },
  async (t) => {
    const testName = "approvals: auto-approve runs without a card";
    const result = await runPageTest(testName, async ({ page, context }) => {
      const approvalRequests: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/api/runtime/approvals")) approvalRequests.push(request.url());
      });

      await openWorkspace(page, context);
      const input = page.getByTestId("composer-input");
      await input.fill(RISKY_PROMPT);
      await input.focus();
      await input.press("Enter");

      const log = page.getByTestId("conversation-log");
      await log.getByText(new RegExp(`Running: ${FAKE_CLAUDE_AUTO_APPROVE_COMMAND}`)).first().waitFor({
        state: "visible",
        timeout: 30_000,
      });
      await page.waitForFunction(() => document.querySelector('[data-testid="run-indicator"]')?.getAttribute("data-phase") === "finished");

      assert.equal(await page.locator('[role="alertdialog"]').count(), 0, "no approval card in auto-approve mode");
      assert.deepEqual(approvalRequests, [], "the client must never poll the approvals API");
      await captureView(page, testName, "auto-approved");
    });
    if (result.skipped) t.skip(result.skipped);
  },
);
