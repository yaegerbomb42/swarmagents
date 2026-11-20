/**
 * Minimal main page e2e.
 *
 * The page has exactly three stacked surfaces plus the right-edge settings
 * tab: the live VM screen, the conversation log, and the composer. Everything
 * else lives in the settings drawer. These specs cover the drawer (mouse and
 * keyboard), the attachment chips, auto-approved streaming runs, the inline
 * ask_user card (including reload persistence) and the server-side VM-only
 * refusal.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Page } from "playwright-core";
import { captureView, closeBrowser, mode, openWorkspace, runPageTest } from "./lib";
import {
  FAKE_CLAUDE_ASSISTANT_TEXT,
  FAKE_CLAUDE_AUTO_APPROVE_ASSISTANT_TEXT,
  FAKE_CLAUDE_HOST_TARGET_TRIGGER,
  FAKE_CLAUDE_QUESTION,
  FAKE_CLAUDE_QUESTION_TRIGGER,
} from "../lib/vm/fake-claude";

after(async () => {
  await closeBrowser();
});

const readOnly = mode() === "prod";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const WEBM_HEADER = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]);

async function drawerLeft(page: Page): Promise<number> {
  return page.getByTestId("settings-drawer").evaluate((el) => el.getBoundingClientRect().left);
}

/** Wait for the 200ms slide transition to settle on either side. */
async function waitForDrawer(page: Page, open: boolean): Promise<void> {
  await page.waitForFunction(
    (shouldOpen) => {
      const el = document.querySelector('[data-testid="settings-drawer"]');
      if (!el) return false;
      const left = el.getBoundingClientRect().left;
      return shouldOpen ? left < window.innerWidth - 100 : left >= window.innerWidth - 1;
    },
    open,
    { timeout: 5_000 },
  );
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("composer-input");
  await input.fill(text);
  await input.focus();
  await input.press("Enter");
}

test(
  "minimal main page: only screen, log and composer; settings drawer via mouse and keyboard",
  { skip: readOnly ? "prod mode is read-only" : false },
  async (t) => {
    const testName = "minimal main page: layout and settings drawer";
    const result = await runPageTest(
      testName,
      async ({ page, context }) => {
        await openWorkspace(page, context);

        await page.getByTestId("minimal-main-page").waitFor({ state: "visible", timeout: 15_000 });
        await page.getByTestId("composer").waitFor({ state: "visible", timeout: 15_000 });
        await page.getByTestId("view-chat").waitFor({ state: "visible" });
        await page.getByTestId("view-screen").click();
        await page.getByTestId("screen-frame").waitFor({ state: "visible", timeout: 15_000 });
        await page.getByTestId("view-chat").click();

        assert.equal(await page.locator("[data-testid='thread-rail-desktop']").count(), 0);
        assert.equal(await page.locator("[data-testid='right-drawer']").count(), 0);
        assert.equal(await page.locator("[data-testid='mobile-tab-bar']").count(), 0);
        assert.equal(await page.locator("[data-testid='activity-strip']").count(), 0);
        assert.equal(await page.getByTestId("role-trigger").count(), 0);

        await page.getByTestId("open-settings").click();
        const sheet = page.getByTestId("settings-sheet");
        await sheet.waitFor({ state: "visible", timeout: 10_000 });
        for (const tab of ["providers", "agent", "computers", "memory", "account"]) {
          await page.getByTestId(`settings-tab-${tab}`).click();
          assert.equal(await page.getByTestId(`settings-tab-${tab}`).getAttribute("aria-selected"), "true");
        }
        await page.getByTestId("settings-sheet-backdrop").click({ position: { x: 8, y: 8 } });
        await sheet.waitFor({ state: "hidden", timeout: 10_000 });
        await page.getByTestId("open-settings").click();
        await sheet.waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
        await sheet.waitFor({ state: "hidden", timeout: 10_000 });
        await captureView(page, testName, "drawer-open");
      },
      { viewport: DESKTOP },
    );
    if (result.skipped) t.skip(result.skipped);
  },
);

test(
  "minimal main page: image, video and file attachments become removable chips",
  { skip: readOnly ? "prod mode is read-only" : false },
  async (t) => {
    const testName = "minimal main page: composer attachments";
    const result = await runPageTest(
      testName,
      async ({ page, context }) => {
        await openWorkspace(page, context);
        await page.getByTestId("attachment-input").setInputFiles([
          { name: "photo.png", mimeType: "image/png", buffer: PNG_1X1 },
          { name: "clip.webm", mimeType: "video/webm", buffer: WEBM_HEADER },
          { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello from a file") },
        ]);

        const chips = page.getByTestId("attachment-chip");
        await chips.first().waitFor({ state: "visible", timeout: 10_000 });
        assert.equal(await chips.count(), 3);
        assert.deepEqual(await chips.allInnerTexts(), await chips.allInnerTexts());
        assert.match(await chips.nth(0).innerText(), /photo\.png/);
        assert.match(await chips.nth(1).innerText(), /clip\.webm/);
        assert.match(await chips.nth(2).innerText(), /notes\.txt/);
        await captureView(page, testName, "three-chips");

        await page.getByRole("button", { name: "Remove photo.png" }).click();
        assert.equal(await chips.count(), 2);
        assert.match(await chips.nth(0).innerText(), /clip\.webm/);
        assert.match(await chips.nth(1).innerText(), /notes\.txt/);
      },
      { viewport: DESKTOP },
    );
    if (result.skipped) t.skip(result.skipped);
  },
);

test(
  "minimal main page: a run streams narration and auto-approves without approval cards",
  { skip: readOnly ? "prod mode is read-only" : false },
  async (t) => {
    const testName = "minimal main page: streaming log and auto-approve";
    const result = await runPageTest(
      testName,
      async ({ page, context }) => {
        await openWorkspace(page, context);

        await send(page, "Run a quick end-to-end smoke check.");
        const log = page.getByTestId("conversation-log");
        await log.getByText("Run a quick end-to-end smoke check.").first().waitFor({ state: "visible", timeout: 30_000 });
        await log.getByText(/Running: uname -a/).first().waitFor({ state: "visible", timeout: 30_000 });
        await log.getByText(FAKE_CLAUDE_ASSISTANT_TEXT).first().waitFor({ state: "visible", timeout: 30_000 });
        await page.waitForFunction(() => document.querySelector('[data-testid="run-indicator"]')?.getAttribute("data-phase") === "finished");
        assert.equal(await page.locator('[role="alertdialog"]').count(), 0, "auto-approve shows no approval card");
        await captureView(page, testName, "finished-run");

        // A routine ask-classified call (pip install) is auto-approved: no
        // approval dialog and the run finishes.
        await send(page, "Install flask so we can test the auto-approve path.");
        await log.getByText(/Running: pip install flask/).first().waitFor({ state: "visible", timeout: 30_000 });
        await log.getByText(FAKE_CLAUDE_AUTO_APPROVE_ASSISTANT_TEXT).first().waitFor({ state: "visible", timeout: 30_000 });
        await page.waitForFunction(() => document.querySelector('[data-testid="run-indicator"]')?.getAttribute("data-phase") === "finished");
        assert.equal(await page.locator('[role="alertdialog"]').count(), 0);
      },
      { viewport: DESKTOP },
    );
    if (result.skipped) t.skip(result.skipped);
  },
);

test(
  "minimal main page: dispatch failures never fall back to text-only or simulated completion",
  { skip: readOnly ? "prod mode is read-only" : false },
  async (t) => {
    const testName = "minimal main page: dispatch failure is an error";
    const result = await runPageTest(
      testName,
      async ({ page, context }) => {
        let providerCompletionCalls = 0;
        let networkFailure = false;
        await context.route("**/api/providers", (route) =>
          route.fulfill({ json: { providers: [{ id: "openai", keyCount: 1, enabled: true }] } }),
        );
        await context.route("**/api/providers/complete", async (route) => {
          providerCompletionCalls += 1;
          await route.fulfill({ json: { text: "text-only response", provider: "openai", model: "fixture" } });
        });
        await context.route("**/api/runtime/threads?*", (route) => route.fulfill({ json: { threads: [] } }));
        await context.route("**/api/runtime/runs?*", (route) => route.fulfill({ json: { runs: [] } }));
        await context.route("**/api/runtime/tasks", async (route) => {
          if (networkFailure) await route.abort("failed");
          else await route.fulfill({ status: 503, json: { error: "runtime control plane unavailable" } });
        });
        await openWorkspace(page, context);

        const log = page.getByTestId("conversation-log");
        await send(page, "This prompt requires real VM execution.");
        await page.getByTestId("composer-error").getByText(/runtime control plane unavailable/).waitFor({ state: "visible", timeout: 10_000 });
        assert.equal(providerCompletionCalls, 0);

        networkFailure = true;
        await send(page, "A network failure must also remain an error.");
        await page.getByTestId("composer-error").getByText(/Network error|failed/i).waitFor({ state: "visible", timeout: 10_000 });
        assert.equal(providerCompletionCalls, 0);

        // Leave enough time for the old simulated engine to have emitted a
        // misleading completion if it had been started implicitly.
        await page.waitForTimeout(1_500);
        assert.equal(providerCompletionCalls, 0, "dispatch failure must not invoke text-only completion");
        assert.equal(await log.getByText(/routed via server provider|done ·/).count(), 0);
        assert.equal(await log.getByText(/^Done\b/).count(), 0, "unexecuted work must not be marked done");
      },
      { viewport: DESKTOP },
    );
    if (result.skipped) t.skip(result.skipped);
  },
);

test(
  "minimal main page: ask_user pauses, survives a reload, and resumes with the answer",
  { skip: readOnly ? "prod mode is read-only" : false },
  async (t) => {
    const testName = "minimal main page: ask_user round trip";
    const result = await runPageTest(
      testName,
      async ({ page, context }) => {
        await openWorkspace(page, context);
        await send(page, `Build me a game. ${FAKE_CLAUDE_QUESTION_TRIGGER} to use.`);

        let card = page.getByTestId("question-card");
        await card.waitFor({ state: "visible", timeout: 30_000 });
        assert.match(await card.innerText(), new RegExp(FAKE_CLAUDE_QUESTION));
        assert.equal(await card.getByTestId("question-option").count(), 2);

        // Reload: the pending question is fetched from the server, so the
        // paused run is not lost.
        await page.reload({ waitUntil: "domcontentloaded" });
        await openWorkspace(page, context);
        card = page.getByTestId("question-card");
        await card.waitFor({ state: "visible", timeout: 30_000 });
        assert.match(await card.innerText(), new RegExp(FAKE_CLAUDE_QUESTION));

        await card.getByRole("button", { name: "Three.js" }).click();
        await card.getByText("Three.js").first().waitFor({ state: "visible", timeout: 15_000 });
        await page
          .getByTestId("conversation-log")
          .getByText("Building the game with the engine you chose.")
          .first()
          .waitFor({ state: "visible", timeout: 30_000 });
        await page.waitForFunction(() => document.querySelector("[data-testid='run-indicator']")?.getAttribute("data-phase") === "finished", undefined, { timeout: 45_000 });
      },
      { viewport: DESKTOP },
    );
    if (result.skipped) t.skip(result.skipped);
  },
);

test(
  "minimal main page: a host-targeted tool call is refused by the server even with auto-approve",
  { skip: readOnly ? "prod mode is read-only" : false },
  async (t) => {
    const testName = "minimal main page: VM-only refusal";
    const result = await runPageTest(
      testName,
      async ({ page, context }) => {
        await openWorkspace(page, context);
        await send(page, `Please ${FAKE_CLAUDE_HOST_TARGET_TRIGGER} before we start.`);

        const log = page.getByTestId("conversation-log");
        const steps = log.getByTestId("steps-block").last();
        await steps.waitFor({ state: "visible", timeout: 30_000 });
        await steps.click();
        const blocked = log.getByText(/Blocked/).first();
        await blocked.waitFor({ state: "visible", timeout: 30_000 });
        assert.match(await blocked.innerText(), /VM-only policy/);
        await log.getByText(/VM-only policy/).first().waitFor({ state: "visible", timeout: 15_000 });
        assert.equal(await page.locator('[role="alertdialog"]').count(), 0, "denials never become approval cards");
        await captureView(page, testName, "vm-only-blocked");
      },
      { viewport: DESKTOP },
    );
    if (result.skipped) t.skip(result.skipped);
  },
);

test(
  "minimal main page: 390x844 keeps the composer above the safe area with no horizontal scroll",
  { skip: readOnly ? "prod mode is read-only" : false },
  async (t) => {
    const testName = "minimal main page: mobile layout";
    const result = await runPageTest(
      testName,
      async ({ page, context }) => {
        await openWorkspace(page, context);
        const sendButton = page.getByTestId("composer-send");
        await sendButton.waitFor({ state: "visible", timeout: 15_000 });
        const box = await sendButton.boundingBox();
        assert.ok(box, "expected the Send button to have layout");
        assert.ok(box.y + box.height <= PHONE.height + 1, "Send must stay inside the viewport");
        const horizontal = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        );
        assert.equal(horizontal, false, "no horizontal scroll at 390px");
        await page.getByTestId("open-settings").click();
        await page.getByTestId("settings-sheet").waitFor({ state: "visible" });
        await captureView(page, testName, "mobile");
      },
      { viewport: PHONE },
    );
    if (result.skipped) t.skip(result.skipped);
  },
);
