/**
 * The workspace's three flows in a real browser, against the real server.
 *
 *   A  Run a VM: start a run, watch it, stop it, answer an approval, read the result.
 *   B  Chat: send, see it at once, see the reply, find it again after a reload.
 *   C  Board: add a task, run it on the VM, submit the result for review.
 *
 * Local mode only (the fake VM replays recorded transcripts through the real
 * runtime); production mode is read-only.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Page } from "playwright-core";
import {
  captureView,
  closeBrowser,
  mode,
  openWorkspace,
  runPageTest,
  sendMessage,
  startNewChat,
  waitForLastTurn,
} from "./lib";
import {
  FAKE_CLAUDE_APPROVAL_TRIGGER,
  FAKE_CLAUDE_ASSISTANT_TEXT,
  FAKE_CLAUDE_QUESTION,
  FAKE_CLAUDE_QUESTION_OPTIONS,
  FAKE_CLAUDE_QUESTION_TRIGGER,
} from "../lib/vm/fake-claude";

after(async () => {
  await closeBrowser();
});

const skip = mode() === "prod" ? "prod mode is read-only" : false;
const PHONE = { width: 390, height: 844 };

/**
 * Every button, link and field on the page has a name a screen reader can say.
 *
 * A plain function declaration with no nested functions: tsx injects a
 * `__name` helper into arrow functions assigned to consts inside the
 * evaluated function, and the serialized source then throws
 * `__name is not defined` when Playwright evaluates it in the page.
 * (Strings are no better: the app's CSP blocks the eval Playwright uses
 * for string predicates.)
 */
function unnamedControlsFn(): string[] {
  const out: string[] = [];
  const els = document.querySelectorAll("button, a[href], input:not([type=hidden]), textarea, select");
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const rect = el.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden")) continue;
    const label = el.getAttribute("aria-label") || el.getAttribute("title") || "";
    let named = false;
    if (label.trim()) named = true;
    else if (el.getAttribute("aria-labelledby")) named = true;
    else if ((el.textContent || "").trim()) named = true;
    else {
      const withLabels = el as HTMLElement & { labels?: { length: number } | null };
      if (withLabels.labels && withLabels.labels.length > 0) named = true;
      else if (el.getAttribute("placeholder")) named = true;
    }
    if (!named) out.push(el.outerHTML.slice(0, 160));
  }
  return out;
}

// Page functions are passed as plain self-contained functions, never strings:
// the app's CSP blocks the eval Playwright uses for string predicates, and a
// function that closes over test-file scope would not survive serialization
// into the page anyway.
function unnamedControls(page: Page): Promise<string[]> {
  return page.evaluate(unnamedControlsFn) as Promise<string[]>;
}

/** How far the page scrolls sideways (0 when it does not). */
function overflowX(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) as Promise<number>;
}

function waitForFocus(page: Page, testId: string): Promise<unknown> {
  return page.waitForFunction(
    (wanted) => {
      const el = document.activeElement;
      return el !== null && el.getAttribute("data-testid") === wanted;
    },
    testId,
    { timeout: 5_000 },
  );
}

const NO_STOP_BUTTON = (): boolean => !document.querySelector('[data-testid="stop-run"]');

async function setApprovals(page: Page, mode: "auto" | "ask"): Promise<void> {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-tab-agent").click();
  await page.getByTestId(`approvals-${mode}`).click();
  assert.equal(await page.getByTestId(`approvals-${mode}`).getAttribute("aria-checked"), "true");
  await page.keyboard.press("Escape");
  await page.getByTestId("settings-sheet").waitFor({ state: "hidden", timeout: 5_000 });
}

test("flow A+B: a message becomes a run, the screen opens, the reply and report follow, and it survives a reload", { skip }, async (t) => {
  const testName = "workspace: chat to run to result";
  const result = await runPageTest(testName, async ({ page, context, consoleErrors }) => {
    await openWorkspace(page, context);
    await startNewChat(page);
    // The stage is the always-mounted main area since the three-component
    // view: a new chat is just the prompt when it holds no turns yet.
    assert.equal(await page.getByTestId("turn").count(), 0, "a new chat is just the prompt");
    assert.deepEqual(await unnamedControls(page), []);
    await captureView(page, testName, "1-new-chat");

    await sendMessage(page, "Run a quick end-to-end smoke check.");

    // The message is in the conversation at once, with a working state.
    const log = page.getByTestId("conversation-log");
    await log.getByText("Run a quick end-to-end smoke check.").waitFor({ state: "visible", timeout: 5_000 });
    assert.equal(await page.getByTestId("composer-input").inputValue(), "", "the box emptied");

    // The run is announced in the header with Stop, and the screen opens beside the chat.
    // 30s, not 15s: on a cold server (or a loaded shared runner) the fake
    // VM takes a while to pick the run up, and the message is already in the
    // log — the run itself just has not started yet.
    await page.getByTestId("stop-run").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("screen-frame").waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await page.getByTestId("minimal-main-page").getAttribute("data-view"), "screen");
    await page.getByTestId("screen-status-pill").waitFor({ state: "visible" });
    await captureView(page, testName, "2-running");

    // The result: the agent's reply, a Finished status, no more Stop, and the report.
    // Turns only render in the chat view; the run plays on the screen.
    await page.getByTestId("view-chat").click();
    await waitForLastTurn(page, "finished");
    await log.getByText(FAKE_CLAUDE_ASSISTANT_TEXT).first().waitFor({ state: "visible", timeout: 15_000 });
    await page.getByTestId("stop-run").waitFor({ state: "hidden", timeout: 15_000 });
    assert.equal(await page.getByTestId("run-indicator").getAttribute("data-phase"), "finished");
    const turn = page.locator('[data-testid="turn"]').last();
    await turn.getByTestId("run-report-toggle").click();
    await turn.getByTestId("run-report-body").getByText("Timeline").waitFor({ state: "visible", timeout: 30_000 });
    await turn.getByTestId("run-report-body").getByText("Files changed").waitFor({ state: "visible" });
    assert.deepEqual(await unnamedControls(page), []);
    await captureView(page, testName, "3-finished-with-report");

    // The steps the agent took are readable on the finished turn.
    await page.getByTestId("view-chat").click();
    assert.equal(await page.getByTestId("minimal-main-page").getAttribute("data-view"), "chat");
    assert.equal(await page.getByTestId("screen-frame").isVisible(), false, "the screen is hidden behind the chat");
    await captureView(page, testName, "4-chat-only");

    // Chat survives a reload: same conversation, same reply.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("conversation-log").getByText(FAKE_CLAUDE_ASSISTANT_TEXT).first().waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("conversation-log").getByText("Run a quick end-to-end smoke check.").first().waitFor({ state: "visible" });
    // The newest turn replays what the agent did; an earlier one shows it on request.
    const reloaded = page.locator('[data-testid="turn"]').last();
    await reloaded.getByTestId("steps-block").first().click();
    await reloaded.getByTestId("tool-entry").first().waitFor({ state: "visible", timeout: 20_000 });

    // And it is in the history, one click away.
    await page.getByTestId("open-history").click();
    await page.getByTestId("history-thread").first().waitFor({ state: "visible", timeout: 10_000 });
    await captureView(page, testName, "5-history");
    await page.keyboard.press("Escape");
    await page.getByTestId("history-panel").waitFor({ state: "hidden", timeout: 5_000 });

    assert.deepEqual(consoleErrors, [], "no console errors on the way");
  });
  if (result.skipped) t.skip(result.skipped);
});

test("flow A: Stop ends the run from every view, even when pressed before the server has answered", { skip }, async (t) => {
  const testName = "workspace: stop a run";
  // The question transcript holds the run open until it is answered: a run that cannot finish on its own.
  const prompt = `Before you start, ${FAKE_CLAUDE_QUESTION_TRIGGER} should we use?`;
  const result = await runPageTest(testName, async ({ page, context }) => {
    await openWorkspace(page, context, { devMode: true });
    await startNewChat(page);

    // Stop is on screen the moment a message is sent. Pressed right then,
    // before the server has created the run, it still stops that run.
    await sendMessage(page, prompt);
    await page.getByTestId("stop-run").click();
    // Turns only render in the chat view; the run plays on the screen.
    await page.getByTestId("view-chat").click();
    await waitForLastTurn(page, "cancelled", 30_000);
    await page.waitForFunction(NO_STOP_BUTTON, undefined, { timeout: 15_000 });

    // A run that is under way: Stop is in reach from every view.
    await sendMessage(page, prompt);
    await page.getByTestId("view-chat").click();
    await page.getByTestId("question-card").last().getByTestId("question-option").first().waitFor({ state: "visible", timeout: 30_000 });
    for (const view of ["chat", "board", "screen"]) {
      await page.getByTestId(`view-${view}`).click();
      assert.equal(await page.getByTestId("stop-run").isVisible(), true, `Stop is reachable from ${view}`);
    }
    await captureView(page, testName, "1-waiting");

    await page.getByTestId("stop-run").click();
    await page.getByTestId("view-chat").click();
    await waitForLastTurn(page, "cancelled", 30_000);
    await page.waitForFunction(NO_STOP_BUTTON, undefined, { timeout: 15_000 });
    assert.equal(await page.getByTestId("run-indicator").getAttribute("data-phase"), "cancelled");
    await page.getByTestId("run-indicator").getByText("Stopped").waitFor({ state: "visible" });

    // The question the run left open is a record now, not something to answer.
    assert.equal(await page.getByTestId("question-option").count(), 0);
    assert.equal(await page.getByTestId("question-answer").count(), 0);
    await captureView(page, testName, "2-stopped");
  });
  if (result.skipped) t.skip(result.skipped);
});

test("flow A: a question from the agent is answered in place and the run continues", { skip }, async (t) => {
  const testName = "workspace: answer a question";
  const result = await runPageTest(testName, async ({ page, context }) => {
    await openWorkspace(page, context);
    await startNewChat(page);
    await sendMessage(page, `Build a small game. First tell me ${FAKE_CLAUDE_QUESTION_TRIGGER} to use.`);

    // The question card only renders in the chat view; the run plays on the screen.
    await page.getByTestId("view-chat").click();
    const card = page.getByTestId("question-card");
    await card.waitFor({ state: "visible", timeout: 30_000 });
    await card.getByText(FAKE_CLAUDE_QUESTION).waitFor({ state: "visible" });
    await page.locator('[data-testid="run-indicator"][data-phase="question"]').waitFor({ state: "visible", timeout: 10_000 });
    await captureView(page, testName, "asked");

    await card.getByTestId("question-option").filter({ hasText: FAKE_CLAUDE_QUESTION_OPTIONS[0] }).click();
    await waitForLastTurn(page, "finished");
    await captureView(page, testName, "answered");
  });
  if (result.skipped) t.skip(result.skipped);
});

test("flow A: with approvals on, the prompt is in front of every view and Deny / Approve act in place", { skip }, async (t) => {
  const testName = "workspace: approval prompt";
  const result = await runPageTest(testName, async ({ page, context }) => {
    await openWorkspace(page, context, { devMode: true });
    await startNewChat(page);
    await setApprovals(page, "ask");

    try {
      // Deny.
      await sendMessage(page, `Please ${FAKE_CLAUDE_APPROVAL_TRIGGER} to clean up.`);
      const dialog = page.locator('[role="alertdialog"]');
      await dialog.waitFor({ state: "visible", timeout: 30_000 });
      await dialog.getByText(FAKE_CLAUDE_APPROVAL_TRIGGER).first().waitFor({ state: "visible" });
      await page.locator('[data-testid="run-indicator"][data-phase="approval"]').waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(await page.getByTestId("stop-run").isVisible(), true, "Stop stays in reach under the prompt");

      // The cursor was in the composer when the prompt arrived. It stays there,
      // so keys already being typed are text, not an answer ("a" approves, "d" denies).
      await waitForFocus(page, "composer-input");
      await page.keyboard.type("add a dash");
      assert.equal(await page.getByTestId("composer-input").inputValue(), "add a dash");
      assert.equal(await dialog.isVisible(), true, "typing did not answer the prompt");
      await page.getByTestId("composer-input").fill("");
      // Tab moves into the prompt.
      await page.keyboard.press("Tab");
      await page.waitForFunction(
        () => Boolean(document.activeElement && document.activeElement.closest('[role="alertdialog"]')),
        undefined,
        { timeout: 5_000 },
      );
      await captureView(page, testName, "1-asked-on-screen");

      // The prompt follows the user to the board.
      await page.getByTestId("view-board").click({ force: true });
      assert.equal(await dialog.isVisible(), true, "the prompt is over the board too");
      await captureView(page, testName, "2-asked-on-board");

      await dialog.getByRole("button", { name: /^Deny/ }).click();
      await dialog.waitFor({ state: "hidden", timeout: 15_000 });
      await page.waitForFunction(NO_STOP_BUTTON, undefined, { timeout: 60_000 });
      assert.equal(await page.locator('[role="alertdialog"]').count(), 0);
      await captureView(page, testName, "3-denied");

      // Approve.
      await page.getByTestId("view-chat").click();
      await page.waitForFunction(NO_STOP_BUTTON, undefined, { timeout: 60_000 });
      await sendMessage(page, `Now really ${FAKE_CLAUDE_APPROVAL_TRIGGER}, I am sure.`);
      await dialog.waitFor({ state: "visible", timeout: 30_000 });
      await dialog.getByRole("button", { name: /Allow approval/ }).click();
      await dialog.waitFor({ state: "hidden", timeout: 15_000 });
      await page.waitForFunction(NO_STOP_BUTTON, undefined, { timeout: 60_000 });
      await captureView(page, testName, "4-approved");
    } finally {
      await page.getByTestId("view-chat").click().catch(() => undefined);
      await setApprovals(page, "auto").catch(() => undefined);
    }
  });
  if (result.skipped) t.skip(result.skipped);
});

test("flow C: a task is added to the board, run on the VM, and submitted for review", { skip }, async (t) => {
  const testName = "workspace: board task to review";
  const title = `Fix the login redirect ${Date.now()}`;
  const result = await runPageTest(testName, async ({ page, context }) => {
    await openWorkspace(page, context, { devMode: true });
    await startNewChat(page);
    await page.getByTestId("view-board").click();
    const board = page.getByTestId("board-panel");
    await board.waitFor({ state: "visible" });
    // The board takes the whole view in the three-component layout; the chat
    // is a tab away, not a column beside it.
    assert.equal(await page.getByTestId("minimal-main-page").getAttribute("data-view"), "board");

    // Add.
    await page.getByTestId("board-add-input").fill(`${title}\nUsers land on a blank page after sign in.`);
    await page.getByTestId("board-add-submit").click();
    const row = page.locator('[data-testid="board-task"]', { hasText: title });
    await row.waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await row.getAttribute("data-status"), "open");
    assert.equal(await page.getByTestId("board-add-input").inputValue(), "", "the box emptied");
    await captureView(page, testName, "1-added");

    // Run: the task is claimed for this user's VM and a run starts in the chat.
    await row.getByTestId("board-run").click();
    await page.getByTestId("stop-run").waitFor({ state: "visible", timeout: 15_000 });
    await page.locator(`[data-testid="board-task"][data-status="claimed"]`, { hasText: title }).waitFor({ state: "visible", timeout: 15_000 });
    await captureView(page, testName, "2-running");

    // The run's prompt is in the conversation, which only mounts in the chat view.
    await page.getByTestId("view-chat").click();
    await page.getByTestId("conversation-log").getByText(title).first().waitFor({ state: "visible", timeout: 15_000 });

    // Result: the run finishes; the row links to it and offers to submit.
    await waitForLastTurn(page, "finished");
    await page.getByTestId("view-board").click();
    const claimed = page.locator('[data-testid="board-task"]', { hasText: title });
    await claimed.getByTestId("board-view-run").waitFor({ state: "visible", timeout: 15_000 });
    await claimed.getByTestId("board-task-title").click();
    const form = claimed.getByTestId("board-submit");
    await form.waitFor({ state: "visible", timeout: 10_000 });
    await form.getByLabel("Branch").fill("fix/login-redirect");
    await form.getByLabel(/Pull request/).fill("https://github.com/acme/app/pull/128");
    await captureView(page, testName, "3-submit-form");
    await claimed.getByTestId("board-submit-button").click();

    const reviewed = page.locator(`[data-testid="board-task"][data-status="in_review"]`, { hasText: title });
    await reviewed.waitFor({ state: "visible", timeout: 15_000 });
    await reviewed.getByRole("link", { name: /PR #128/ }).first().waitFor({ state: "visible" });
    assert.deepEqual(await unnamedControls(page), []);
    await captureView(page, testName, "4-in-review");
  });
  if (result.skipped) t.skip(result.skipped);
});

test("phone: the same three flows fit a 390px screen without sideways scrolling", { skip }, async (t) => {
  const testName = "workspace: phone";
  const result = await runPageTest(
    testName,
    async ({ page, context }) => {
      await openWorkspace(page, context, { devMode: true });
      await startNewChat(page);
      assert.ok((await overflowX(page)) <= 0, "no sideways scroll on the new chat");
      await captureView(page, testName, "1-new-chat");

      await sendMessage(page, "Run a quick end-to-end smoke check.");
      await page.getByTestId("stop-run").waitFor({ state: "visible", timeout: 15_000 });
      assert.equal(await page.getByTestId("minimal-main-page").getAttribute("data-view"), "chat", "a phone stays on the chat");

      // The screen stacks above the chat; the composer is still there.
      await page.getByTestId("view-screen").click();
      await page.getByTestId("screen-frame").waitFor({ state: "visible" });
      assert.equal(await page.getByTestId("composer-input").isVisible(), true);
      assert.ok((await overflowX(page)) <= 0, "no sideways scroll with the screen open");
      await captureView(page, testName, "2-screen");

      // Turns only render in the chat view; the run plays on the screen.
      await page.getByTestId("view-chat").click();
      await waitForLastTurn(page, "finished");
      await captureView(page, testName, "3-finished");

      // The board takes the whole view; the way back is one tap.
      await page.getByTestId("view-board").click();
      await page.getByTestId("board-panel").waitFor({ state: "visible" });
      assert.equal(await page.getByTestId("chat-column").isVisible(), false);
      assert.ok((await overflowX(page)) <= 0, "no sideways scroll on the board");
      assert.deepEqual(await unnamedControls(page), []);
      await captureView(page, testName, "4-board");

      await page.getByTestId("open-settings").click();
      await page.getByTestId("settings-sheet").waitFor({ state: "visible" });
      assert.ok((await overflowX(page)) <= 0, "no sideways scroll in settings");
      await captureView(page, testName, "5-settings");
      await page.keyboard.press("Escape");

      await page.getByTestId("view-chat").click();
      assert.equal(await page.getByTestId("composer-input").isVisible(), true);
    },
    { viewport: PHONE },
  );
  if (result.skipped) t.skip(result.skipped);
});

test("keyboard: the composer is one shortcut away and the sheets close with Escape", { skip }, async (t) => {
  const testName = "workspace: keyboard";
  const result = await runPageTest(testName, async ({ page, context }) => {
    await openWorkspace(page, context, { devMode: true });
    await page.getByTestId("view-board").click();
    await page.keyboard.press("ControlOrMeta+k");
    await waitForFocus(page, "composer-input");

    // Shift+Enter is a new line, not a send.
    await page.getByTestId("composer-input").fill("line one");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("line two");
    assert.equal(await page.getByTestId("composer-input").inputValue(), "line one\nline two");
    await page.getByTestId("composer-input").fill("");

    // The view switch is a tab list: arrow keys move between views.
    await page.getByTestId("view-board").focus();
    await page.keyboard.press("ArrowLeft");
    assert.equal(await page.getByTestId("minimal-main-page").getAttribute("data-view"), "screen");

    // Settings: opens on providers, focus moves into the sheet, Escape closes it and focus returns.
    await page.getByTestId("open-settings").focus();
    await page.keyboard.press("Enter");
    await page.getByTestId("settings-sheet").waitFor({ state: "visible" });
    assert.equal(await page.getByTestId("settings-tab-providers").getAttribute("aria-selected"), "true");
    await page.waitForFunction(
      () => Boolean(document.activeElement && document.activeElement.closest('[data-testid="settings-sheet"]')),
      undefined,
      { timeout: 5_000 },
    );
    await captureView(page, testName, "settings-providers");
    await page.getByTestId("settings-tab-agent").click();
    await page.getByTestId("agent-settings").waitFor({ state: "visible" });
    assert.equal(await page.getByTestId("settings-tab-agent").getAttribute("aria-selected"), "true");
    assert.notEqual(await page.getByTestId("settings-tab-providers").getAttribute("aria-selected"), "true");
    await captureView(page, testName, "settings-agent");
    await page.keyboard.press("Escape");
    await page.getByTestId("settings-sheet").waitFor({ state: "hidden", timeout: 5_000 });
    await waitForFocus(page, "open-settings");
  });
  if (result.skipped) t.skip(result.skipped);
});
