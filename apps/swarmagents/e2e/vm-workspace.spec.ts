import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeBrowser, ensureFakeProvider, mode, runPageTest, startNewChat, waitForLastTurn } from "./lib";

after(async () => { await closeBrowser(); });

test("composer stays visible below the computer while its views and chat switch", { skip: mode() === "prod" }, async (t) => {
  const result = await runPageTest("vm-workspace", async ({ page }) => {
    // A fresh account has no provider, so the workspace opens first-run
    // setup and the settings sheet covers the view tabs: register the fake
    // provider first, like openWorkspace does.
    await ensureFakeProvider(page);
    const vmStatus = page.waitForResponse((response) => response.url().includes("/api/runtime/vm/status"));
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const vm = await (await vmStatus).json() as { desktop: boolean };
    const composer = page.getByTestId("composer-input");
    await composer.waitFor({ state: "visible", timeout: 30_000 });

    // The screen frame only mounts once a run exists: a new chat shows the
    // hero, not the computer. Start a run first so the layout under test is
    // the one the user watches.
    await startNewChat(page);
    await composer.fill("Run a quick end-to-end smoke check.");
    await composer.press("Enter");
    await page.getByTestId("view-screen").click();
    await page.getByTestId("screen-frame").waitFor({ state: "visible", timeout: 15_000 });
    await page.getByTestId("screen-view-terminal").click();
    await page.getByText("Smoke check complete — the sandbox is healthy.").first().waitFor({ state: "visible", timeout: 30_000 });
    // Turns only render in the chat view; the run plays on the screen.
    await page.getByTestId("view-chat").click();
    await waitForLastTurn(page, "finished");
    await page.getByTestId("view-screen").click();
    const frame = page.getByTestId("screen-frame");
    await frame.waitFor({ state: "visible" });
    const composerBox = await composer.boundingBox();
    const frameBox = await frame.boundingBox();
    // Three-component layout: the input bar sits under the computer, not
    // over it — visible at the bottom while the frame fills the main area.
    assert.ok(composerBox && frameBox && composerBox.y >= frameBox.y + frameBox.height);
    // The fake driver has no desktop. A desktop-enabled server also exercises
    // that tab, but this smoke test does not pretend to verify an RFB frame.
    if (!vm.desktop) await page.getByTestId("screen-view-desktop").waitFor({ state: "detached" });
    const views = [...(vm.desktop ? ["desktop"] : []), "terminal", "browser", "files"];
    for (const view of views) {
      const tab = page.getByTestId(`screen-view-${view}`);
      if (!(await tab.isVisible())) continue;
      await tab.click();
      assert.equal(await tab.getAttribute("aria-selected"), "true");
      assert.equal(await composer.isVisible(), true);
    }
    await page.getByTestId("view-chat").click();
    assert.equal(await frame.count(), 1, "computer stays mounted behind chat");
    assert.equal(await composer.isVisible(), true);
    await page.getByTestId("view-screen").click();
    assert.equal(await frame.isVisible(), true);
    await page.getByTestId("screen-view-terminal").click();
    await page.getByText("Smoke check complete — the sandbox is healthy.").first().waitFor({ state: "visible" });
  });
  if (result.skipped) t.skip(result.skipped);
});
