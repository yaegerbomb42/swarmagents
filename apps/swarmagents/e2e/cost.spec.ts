/**
 * Cost & latency dashboard (g7).
 *
 *   - registers a fake provider for the account (a local stub URL that is
 *     never actually called — the local fake VM replays a recorded transcript
 *     instead of talking to a provider),
 *   - caps the account's per-run budget below the run's reported cost, so the
 *     projection lands between 80% and 100% of the cap,
 *   - dispatches a prompt, opens the Telemetry drawer, and asserts the cost
 *     panel shows live $, the run's tokens, the fake provider's row, a budget
 *     bar at 80%+ and the 80% warning.
 *
 * Desktop (1440x900) and mobile (390x844), full-page screenshots.
 */

import { after, test } from "node:test";
import { captureView, closeBrowser, mode, openWorkspace, runPageTest } from "./lib";

after(async () => {
  await closeBrowser();
});

const readOnly = mode() === "prod";

const FAKE_PROVIDER = {
  id: "fake-e2e",
  apiStyle: "openai-compatible",
  baseUrl: "http://127.0.0.1:9/v1",
  models: ["fake-model"],
  apiKey: "sk-fake-e2e",
  isFree: false,
  inputPricePer1mTokens: 1000,
  outputPricePer1mTokens: 1000,
};

/** Save the per-run budget cap and the fake provider for the local account. */
async function configureAccount(page: import("playwright-core").Page): Promise<void> {
  // Cap the per-run budget below the fake run's reported cost ($0.001), so
  // the projected spend crosses the 80% warning but stays under the cap.
  const settings = await page.request.put("/api/providers/settings", {
    data: { perRunBudgetUsd: 0.0011 },
  });
  if (!settings.ok()) {
    throw new Error(`could not set perRunBudgetUsd: HTTP ${settings.status()} ${await settings.text()}`);
  }
  const saved = await page.request.post("/api/providers", { data: FAKE_PROVIDER });
  if (!saved.ok()) {
    throw new Error(`could not register the fake provider: HTTP ${saved.status()} ${await saved.text()}`);
  }
}

test(
  "cost & latency panel: $, tokens, per-provider row and the 80% budget warning (desktop)",
  { skip: readOnly ? "prod mode is read-only" : false },
  async (t) => {
    const testName = "cost & latency panel: $, tokens, per-provider row and the 80% budget warning (desktop)";
    const result = await runPageTest(
      testName,
      async ({ page, context }) => {
        await configureAccount(page);
        await openWorkspace(page, context);

        const input = page.locator("textarea").first();
        await input.fill("Run a quick end-to-end smoke check.");
        await input.press("Enter");

        await page.getByText(/run started ·/).first().waitFor({ state: "visible", timeout: 30_000 });
        await page.getByText(/run finished · exit 0/).first().waitFor({ state: "visible", timeout: 45_000 });

        // Open the settings drawer, switch to the Workspace section, and
        // scroll the Usage block (spend meter + cost & latency panel) into
        // view.
        await page.getByTestId("settings-tab").click();
        await page.getByRole("tab", { name: "Workspace" }).click();
        const panel = page.getByTestId("cost-latency-panel");
        await panel.waitFor({ state: "visible", timeout: 15_000 });
        await panel.scrollIntoViewIfNeeded();
        await page.getByTestId("run-cost").first().waitFor({ state: "visible", timeout: 10_000 });

        // The cost panel shows live data: the run spent $0.001 (the fake
        // transcript's reported cost).
        await page.locator('[data-testid="run-cost"]', { hasText: "0.001" }).first().waitFor({
          state: "visible",
          timeout: 15_000,
        });

        // Tokens from the fake transcript's usage events are in the panel.
        await page
          .locator('[data-testid="cost-latency-stats"]', { hasText: /\d+ in · \d+ out/ })
          .waitFor({ state: "visible", timeout: 10_000 });
        const stats = (await page.getByTestId("cost-latency-stats").textContent()) ?? "";
        if (!/\d+ in · \d+ out/.test(stats)) {
          throw new Error(`expected token in/out totals in the panel, got "${stats}"`);
        }

        // The fake provider serves the run: it shows up in the per-provider
        // breakdown with the reported cost attributed to it.
        await page
          .locator('[data-testid="cost-provider-row"]', { hasText: "fake-e2e" })
          .first()
          .waitFor({ state: "visible", timeout: 15_000 });

        // The budget bar is past 80% of the cap and the 80% warning shows.
        const bar = page.getByTestId("run-budget-bar");
        await bar.waitFor({ state: "visible", timeout: 10_000 });
        const width = Number(await bar.evaluate((el) => (el as HTMLElement).style.width.replace("%", "")));
        if (!Number.isFinite(width) || width < 80) {
          throw new Error(`expected the budget bar past 80% of the cap, got ${String(width)}%`);
        }
        await page.getByTestId("budget-warning").waitFor({ state: "visible", timeout: 10_000 });

        await captureView(page, testName, "panel");
      },
      { viewport: { width: 1440, height: 900 } },
    );
    if (result.skipped) t.skip(result.skipped);
  },
);

test(
  "cost & latency panel: 80% budget warning on mobile",
  { skip: readOnly ? "prod mode is read-only" : false },
  async (t) => {
    const testName = "cost & latency panel: 80% budget warning on mobile";
    const result = await runPageTest(
      testName,
      async ({ page, context }) => {
        await configureAccount(page);
        await openWorkspace(page, context);

        const input = page.locator("textarea").first();
        await input.fill("Run a quick end-to-end smoke check.");
        await input.press("Enter");

        await page.getByText(/run started ·/).first().waitFor({ state: "visible", timeout: 30_000 });
        await page.getByText(/run finished · exit 0/).first().waitFor({ state: "visible", timeout: 45_000 });

        await page.getByTestId("settings-tab").click();
        await page.getByRole("tab", { name: "Workspace" }).click();
        const panel = page.getByTestId("cost-latency-panel");
        await panel.waitFor({ state: "visible", timeout: 15_000 });
        await panel.scrollIntoViewIfNeeded();
        await page.getByTestId("budget-warning").waitFor({ state: "visible", timeout: 10_000 });
        await page.getByTestId("run-budget-bar").waitFor({ state: "visible", timeout: 10_000 });

        await captureView(page, testName, "panel-mobile");
      },
      { viewport: { width: 390, height: 844 } },
    );
    if (result.skipped) t.skip(result.skipped);
  },
);
