import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeBrowser, mode, runPageTest } from "./lib";

// Run on the local test app with scratch account data, not against a real swarm.
after(closeBrowser);

test("capability catalog: retry, filter, inspect setup and install a real library item", async (t) => {
  if (mode() === "prod") return t.skip("Catalog install requires writes to a scratch account.");

  const result = await runPageTest("capability catalog", async ({ page }) => {
    let failFirstLoad = true;
    let releaseFirstLoad!: () => void;
    const firstLoad = new Promise<void>((resolve) => { releaseFirstLoad = resolve; });
    await page.route("**/api/library/connectors", async (route) => {
      if (!failFirstLoad) return route.continue();
      failFirstLoad = false;
      await firstLoad;
      await route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
    });

    const response = await page.goto("/library", { waitUntil: "domcontentloaded" });
    assert.equal(response?.status(), 200);
    const catalogTab = page.getByTestId("library-tab-catalog");
    await catalogTab.click();
    const catalog = page.getByTestId("swarm-catalog");
    try {
      await catalog.getByText("Loading catalog…", { exact: true }).waitFor();
    } finally {
      releaseFirstLoad();
    }
    await catalog.getByText(/Could not load the catalog/).waitFor();
    await catalog.getByRole("button", { name: "Retry" }).click();

    const search = catalog.getByRole("searchbox", { name: "Search catalog" });
    const entries = catalog.getByTestId("catalog-entry");
    await entries.first().waitFor();
    await catalog.getByLabel("Filter by type").selectOption("tool");
    await catalog.getByLabel("Filter by category").selectOption("comms");
    await catalog.getByText("No matching capabilities").waitFor();
    await catalog.getByRole("button", { name: "Clear filters" }).click();

    await search.fill("bytebase schema");
    const databaseSetup = catalog.getByRole("button", { name: /Set up PostgreSQL/ });
    await databaseSetup.waitFor();
    assert.equal(await entries.count(), 1);
    await databaseSetup.click();
    const detail = catalog.getByTestId("catalog-detail");
    await detail.getByText("What it unlocks").waitFor();
    const connectionString = detail.getByLabel("PostgreSQL connection string");
    assert.equal(await connectionString.getAttribute("type"), "password");
    assert.equal(await detail.getByRole("button", { name: "Add to swarm" }).isDisabled(), true);
    assert.match((await detail.getByRole("link", { name: "View official source" }).getAttribute("href")) ?? "", /github\.com\/bytebase\/dbhub/);
    await detail.getByRole("button", { name: "Back to catalog" }).click();
    assert.equal(await search.inputValue(), "bytebase schema");

    await search.fill("grok");
    await catalog.getByRole("button", { name: /Set up xAI/ }).click();
    const settings = detail.getByRole("link", { name: "Open Provider Settings" });
    assert.equal(await settings.getAttribute("href"), "/providers");
    await detail.getByRole("button", { name: "Back to catalog" }).click();

    await search.fill("json formatter");
    const installed = page.waitForResponse((res) => res.url().endsWith("/api/library/items") && res.request().method() === "POST");
    await catalog.getByRole("button", { name: "Add JSON Formatter" }).click();
    const saved = await installed;
    assert.equal(saved.status(), 201);
    const body = await saved.json() as { item: { id: string; payload: { kind: string } } };
    try {
      assert.equal(body.item.payload.kind, "tool");
      await catalog.getByText(/JSON Formatter was added to your library/).waitFor();
      await page.reload({ waitUntil: "domcontentloaded" });
      await catalogTab.click();
      await catalog.getByTestId("catalog-entry").filter({ hasText: "JSON Formatter" }).getByText("Added", { exact: true }).waitFor();
      assert.equal(await catalog.getByRole("button", { name: "Add JSON Formatter" }).count(), 0);
    } finally {
      await page.request.delete(`/api/library/items/${encodeURIComponent(body.item.id)}`);
    }
  }, { viewport: { width: 390, height: 844 } });
  if (result.skipped) t.skip(result.skipped);
});
