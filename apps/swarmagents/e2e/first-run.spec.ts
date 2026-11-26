/**
 * First-run onboarding e2e (core-24): a brand-new account must reach "I
 * watched it do something" in a few clicks — provider → test ok (with a run
 * mode badge) → sample task → a completed run with the deliverable artifact
 * card, and completion is persisted so the wizard never returns.
 *
 * The local e2e server keeps one account, so "new account" state cannot come
 * from the real server: while a local `fresh` flag is set, the account's
 * provider/runs/threads/settings GETs are mocked to look empty and
 * incomplete. The sample run itself is dispatched to the real server (the
 * server's fake VM driver replays a recorded transcript), so the run, its
 * finished status and its report card are real.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Page } from "playwright-core";
import { captureView, closeBrowser, mode, runPageTest, showChat, waitForLastTurn } from "./lib";

after(async () => {
  await closeBrowser();
});

const readOnly = mode() === "prod";
const DESKTOP = { width: 1440, height: 900 };

test(
  "first run: provider → test ok → sample task → completed run with artifact card",
  { skip: readOnly ? "prod mode is read-only" : false },
  async (t) => {
    const testName = "first run completes with an artifact card";
    const result = await runPageTest(
      testName,
      async ({ page, context }) => {
        // While `fresh` is true the account looks brand-new: no providers, no
        // conversations, no runs, onboarding not yet completed. POSTs (save,
        // probe) are mocked too; everything else falls through to the real
        // server.
        let fresh = true;
        await context.route("**/api/providers", async (route) => {
          const method = route.request().method();
          if (!fresh || method !== "GET") return route.continue();
          await route.fulfill({ json: { catalog: [], providers: [] } });
        });
        await context.route("**/api/providers/settings", async (route) => {
          if (route.request().method() !== "GET") return route.continue();
          await route.fulfill({ json: { alwaysOn247: false, firstRunCompleted: false } });
        });
        await context.route("**/api/providers/groq/test", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          await route.fulfill({
            json: {
              test: { id: "groq", ok: true, latencyMs: 84, checkedAt: Date.now(), model: "llama-3.3-70b-versatile" },
              runMode: { mode: "text-desktop", label: "Text desktop mode", capabilities: {} },
            },
          });
        });
        await context.route("**/api/runtime/threads**", async (route) => {
          if (!fresh || route.request().method() !== "GET") return route.continue();
          await route.fulfill({ json: { threads: [] } });
        });
        await context.route("**/api/runtime/runs**", async (route) => {
          if (!fresh || route.request().method() !== "GET") return route.continue();
          await route.fulfill({ json: { runs: [] } });
        });

        // Click budget for the wizard path: provider, Test, Continue, sample
        // Run — four clicks. The assertion is taken right after the sample is
        // dispatched, before any post-run navigation clicks.
        await context.addInitScript(() => {
          let clicks = 0;
          document.addEventListener("click", () => { clicks += 1; }, true);
          (window as unknown as Record<string, unknown>).__wizardClicks = () => clicks;
        });

        await page.goto("/", { waitUntil: "domcontentloaded" });

        // Step 1: provider pick (free tiers first).
        await page.getByTestId("first-run-setup").waitFor({ state: "visible", timeout: 20_000 });
        await captureView(page, testName, "1-provider");
        await page.getByTestId("fr-provider-groq").click();

        // Step 2: paste key + Test → ok, latency, mode badge.
        await page.getByTestId("fr-step-key").waitFor({ state: "visible", timeout: 10_000 });
        await page.getByTestId("fr-key-input").fill("gsk_first_run_e2e");
        await captureView(page, testName, "2-key");
        await page.getByTestId("fr-test").click();
        await page.getByTestId("fr-test-ok").waitFor({ state: "visible", timeout: 15_000 });
        assert.match(await page.getByTestId("fr-mode-badge").innerText(), /Text desktop/, "the run-mode badge shows");
        await captureView(page, testName, "3-test-ok");
        await page.getByTestId("fr-continue").click();

        // Step 3: pick the sample task.
        await page.getByTestId("fr-step-try").waitFor({ state: "visible", timeout: 10_000 });
        await captureView(page, testName, "4-try");

        // From here the real server owns the conversation: stop mocking.
        fresh = false;
        await page.getByTestId("fr-sample-primes").click();

        // The setup closes and the run goes through the normal path.
        await page.getByTestId("first-run-setup").waitFor({ state: "hidden", timeout: 10_000 });
        const wizardClicks = await page.evaluate(
          () => (window as unknown as { __wizardClicks?: () => number }).__wizardClicks?.(),
        );
        assert.ok(
          typeof wizardClicks === "number" && wizardClicks <= 6,
          `the wizard should take 6 clicks or fewer, saw ${wizardClicks}`,
        );

        // The run opens on the screen; switch to chat to read the log/report.
        await showChat(page);
        const log = page.getByTestId("conversation-log");
        await log.getByText("Print the first 20 primes").first().waitFor({ state: "visible", timeout: 30_000 });
        await waitForLastTurn(page, "finished", 60_000);

        // Deliverable card (#267): the finished turn carries the run report
        // with its Files changed section. The fake VM replays the agent's
        // side only and writes nothing, so the file list itself is only
        // populated on a real VM (see lib/vm/fake-claude.ts).
        const turn = page.locator('[data-testid="turn"]').last();
        await turn.getByTestId("run-report-toggle").click();
        const body = turn.getByTestId("run-report-body");
        await body.getByText("Timeline").waitFor({ state: "visible", timeout: 30_000 });
        await body.getByText("Files changed").waitFor({ state: "visible", timeout: 15_000 });
        await captureView(page, testName, "5-completed-artifact");

        // Completion is persisted (the wizard got the flag from Settings on
        // mount and PUTs it on finish); Settings keeps the replay entry.
        await page.getByTestId("open-settings").click();
        await page.getByTestId("settings-sheet").waitFor({ state: "visible", timeout: 10_000 });
        await page.getByTestId("settings-tab-account").click();
        await page.getByTestId("settings-sample-tasks").waitFor({ state: "visible", timeout: 10_000 });
        await page.getByTestId("settings-sample-primes").waitFor({ state: "visible", timeout: 10_000 });
        await captureView(page, testName, "6-settings-replay");
      },
      { viewport: DESKTOP },
    );
    if (result.skipped) t.skip(result.skipped);
  },
);
