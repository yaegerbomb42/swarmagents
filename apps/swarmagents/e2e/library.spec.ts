/**
 * Public Library, end to end: publish a skill from the browser, see it in the
 * shared catalog labelled unreviewed, read the full SKILL.md before install,
 * install a copy, and find it in this account's Skills tab.
 *
 * Writing to the catalog needs POSTs, so the read-only prod mode skips.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeBrowser, mode, runPageTest } from "./lib";

after(async () => {
  await closeBrowser();
});

test("library: publish, preview and install a copy", async (t) => {
  if (mode() === "prod") {
    t.skip("prod e2e mode is read-only; publishing requires POST requests");
    return;
  }

  const name = `E2E runbook ${Date.now()}`;
  const markdown = "# E2E runbook\n\nRead this before deploying.";
  const result = await runPageTest(
    "library: publish, preview and install",
    async ({ page }) => {
      const response = await page.goto("/library", { waitUntil: "domcontentloaded" });
      assert.ok(response && response.status() < 400, `/library responded ${response?.status()}`);
      await page.getByTestId("library-view").waitFor({ state: "visible", timeout: 15_000 });
      await page.getByTestId("library-publish-open").click();
      const form = page.getByTestId("library-publish-form");
      await form.waitFor({ state: "visible" });
      await form.getByLabel("Name", { exact: true }).fill(name);
      await form.getByLabel("License", { exact: true }).fill("MIT");
      await form.getByLabel("Description", { exact: true }).fill("Created by the e2e suite");
      await form.getByLabel("SKILL.md", { exact: true }).fill(markdown);
      await page.getByTestId("library-publish-submit").click();

      await page.getByText(/Published\. It is labelled unreviewed/).waitFor({ state: "visible", timeout: 15_000 });

      const card = page.getByTestId("library-public-item").filter({ hasText: name }).first();
      await card.waitFor({ state: "visible", timeout: 15_000 });
      assert.match(await card.innerText(), /unreviewed/i);
      assert.match(await card.innerText(), /@/);

      // The installer sees the full, untrusted content before installing.
      await card.getByTestId("library-preview-open").click();
      const preview = page.getByTestId("library-preview");
      await preview.waitFor({ state: "visible" });
      assert.match(await page.getByTestId("library-preview-content").innerText(), /# E2E runbook/);

      await page.getByTestId("library-install").click();
      await page.getByText(/Installed .* into your library/).waitFor({ state: "visible", timeout: 15_000 });

      await page.getByTestId("library-tab-skills").click();
      const installed = page.getByTestId("library-installed-item").filter({ hasText: name }).first();
      await installed.waitFor({ state: "visible", timeout: 15_000 });
      assert.match(await installed.innerText(), /v1/);
    },
    { viewport: { width: 1280, height: 900 } },
  );
  if (result.skipped) t.skip(result.skipped);
});
