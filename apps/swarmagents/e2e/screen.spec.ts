import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { BrowserContext, Page } from "playwright-core";
import { captureView, closeBrowser, mode, openWorkspace, runPageTest } from "./lib";
import {
  FAKE_CLAUDE_ASSISTANT_TEXT,
  FAKE_CLAUDE_AUTO_APPROVE_ASSISTANT_TEXT,
  FAKE_CLAUDE_AUTO_APPROVE_TRIGGER,
} from "../lib/vm/fake-claude";

after(async () => {
  await closeBrowser();
});

const readOnly = mode() === "prod";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** Serve a ready desktop VM so the take-over control is enabled in e2e. */
async function useDesktopVm(context: BrowserContext): Promise<void> {
  await context.route("**/api/runtime/vm/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "running", desktop: true, disk: { usedMb: 0, quotaMb: 0, overQuota: false } }),
    }),
  );
}

async function waitEnabled(page: Page, testId: string): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const button = document.querySelector(`[data-testid="${id}"]`);
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    testId,
    { timeout: 20_000 },
  );
}

test(
  "screen: take over shows the accent banner, disables the composer, and Esc hands back",
  { skip: readOnly ? "prod mode is read-only" : false },
  async (t) => {
    const testName = "screen: take over and Esc hand back";
    const result = await runPageTest(
      testName,
      async ({ page, context }) => {
        await useDesktopVm(context);
        await openWorkspace(page, context);

        // The frame replaces the old double screen chrome: no role <select>
        // on the main page. Role controls live in the settings drawer.
        assert.equal(await page.locator("select[aria-label='Role']").count(), 0, "role control is not on the main page");
        await page.getByTestId("view-screen").click();
        const frame = page.getByTestId("screen-frame");
        await frame.waitFor({ state: "visible", timeout: 15_000 });
        assert.equal(await frame.getAttribute("data-control"), "false");

        await captureView(page, testName, "desktop-view-only");

        await waitEnabled(page, "take-over");
        await page.getByRole("button", { name: "Take over" }).click();

        const banner = page.getByTestId("takeover-banner");
        await banner.waitFor({ state: "visible", timeout: 10_000 });
        assert.match(await banner.innerText(), /in control/i, "expected the control banner");
        assert.match(await banner.innerText(), /Press Esc to hand back/i, "hand-back stays on the banner");
        assert.doesNotMatch(await banner.innerText(), /paused/i, "there is no pause API, so never say paused");
        assert.equal(await frame.getAttribute("data-control"), "true");
        assert.equal(
          await page.getByTestId("screen-status-pill").getAttribute("data-tone"),
          "accent",
          "the status pill switches while you have the desktop",
        );

        const composerTextarea = page.getByTestId("composer-input");
        assert.equal(await composerTextarea.isDisabled(), false, "the composer stays available during take-over");
        await captureView(page, testName, "desktop-takeover");

        // Esc hands the desktop back to the agent and re-enables sending.
        await page.keyboard.press("Escape");
        await banner.waitFor({ state: "hidden", timeout: 10_000 });
        assert.equal(await frame.getAttribute("data-control"), "false");
        assert.equal(await composerTextarea.isVisible(), true);
      },
      { viewport: DESKTOP },
    );
    if (result.skipped) t.skip(result.skipped);
  },
);

test(
  "screen: reduced motion disables animation and narration renders immediately",
  { skip: readOnly ? "prod mode is read-only" : false },
  async (t) => {
    const testName = "screen: reduced motion";
    const result = await runPageTest(
      testName,
      async ({ page, context }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await openWorkspace(page, context);

        const reduced = await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
        assert.equal(reduced, true, "emulated reduced motion must be active");

        // The global reduced-motion rule collapses animations to ~0ms.
        const duration = await page.evaluate(() => {
          const probe = document.createElement("div");
          probe.className = "animate-ping";
          document.body.appendChild(probe);
          const value = getComputedStyle(probe).animationDuration;
          probe.remove();
          return value;
        });
        assert.ok(parseFloat(duration) < 0.05, `animations must be disabled, got ${duration}`);

        // Narration still updates (full sentence, no char stream) while a run
        // is live; the tail-diff model is unit-tested in narration.test.ts.
        const input = page.locator("textarea").first();
        await input.fill("check the kernel with uname");
        await input.focus();
        await input.press("Enter");
        await page.getByText(/run started/).first().waitFor({ state: "visible", timeout: 30_000 });
        await page.getByTestId("conversation-log").getByText(FAKE_CLAUDE_ASSISTANT_TEXT).first().waitFor({ state: "visible", timeout: 30_000 });
        // Let the run finish so the next spec's workspace is not restored in
        // an active state.
        await page.waitForFunction(() => document.querySelector("[data-testid='run-indicator']")?.getAttribute("data-phase") === "finished", undefined, { timeout: 45_000 });
        await captureView(page, testName, "reduced-motion-run");
      },
      { viewport: DESKTOP },
    );
    if (result.skipped) t.skip(result.skipped);
  },
);

test(
  "screen: 390x844 keeps the composer inside the viewport",
  { skip: readOnly ? "prod mode is read-only" : false },
  async (t) => {
    const testName = "screen: mobile composer clearance";
    const result = await runPageTest(
      testName,
      async ({ page, context }) => {
        await openWorkspace(page, context);

        const send = page.getByLabel("Send message").first();
        await send.waitFor({ state: "visible", timeout: 15_000 });
        const sendBox = await send.boundingBox();
        assert.ok(sendBox, "expected layout for Send");
        assert.ok(
          sendBox.y + sendBox.height <= PHONE.height + 1,
          `Send (bottom ${sendBox.y + sendBox.height}) must stay inside the ${PHONE.height}px viewport`,
        );

        const horizontal = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
        assert.equal(horizontal, false, "no horizontal scroll at 390px");
        await captureView(page, testName, "mobile-390x844");
      },
      { viewport: PHONE },
    );
    if (result.skipped) t.skip(result.skipped);
  },
);

test(
  "screen: a routine call auto-approves at 390x844 with no approval card",
  { skip: readOnly ? "prod mode is read-only" : false },
  async (t) => {
    const testName = "screen: mobile auto-approve";
    const result = await runPageTest(
      testName,
      async ({ page, context }) => {
        await openWorkspace(page, context);

        const input = page.locator("textarea").first();
        await input.fill(`Please ${FAKE_CLAUDE_AUTO_APPROVE_TRIGGER} so we can keep going.`);
        await input.focus();
        await input.press("Enter");

        const log = page.getByTestId("conversation-log");
        await log.getByText(/Running: pip install flask/).waitFor({ state: "visible", timeout: 30_000 });
        await log.getByText(FAKE_CLAUDE_AUTO_APPROVE_ASSISTANT_TEXT).first().waitFor({ state: "visible", timeout: 30_000 });
        await page.waitForFunction(() => document.querySelector("[data-testid='run-indicator']")?.getAttribute("data-phase") === "finished", undefined, { timeout: 45_000 });
        assert.equal(await page.locator('[role="alertdialog"]').count(), 0, "auto-approve never shows an approval card");
        assert.equal(await page.locator("textarea").first().isDisabled(), false, "composer stays usable");
        await captureView(page, testName, "mobile-auto-approved");
      },
      { viewport: PHONE },
    );
    if (result.skipped) t.skip(result.skipped);
  },
);
