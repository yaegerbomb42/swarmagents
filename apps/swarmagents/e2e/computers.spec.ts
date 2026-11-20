import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Page } from "playwright-core";
import { captureView, closeBrowser, mode, openWorkspace, runPageTest } from "./lib";

after(async () => {
  await closeBrowser();
});

const readOnly = mode() === "prod";
const TEST_NAME = "computers: pair a BYOC node, run on it, then revoke it";

interface ClaimResponse {
  job: { runId: string; prompt: string } | null;
}

/**
 * Enter the workspace from a cold browser context. The shared helper waits for
 * the composer before dismissing onboarding/launch, which only works when
 * localStorage already says the intro was seen; a fresh e2e context has to
 * clear those two overlays first.
 */
async function enterWorkspace(page: Page): Promise<void> {
  const response = await page.goto("/", { waitUntil: "domcontentloaded" });
  assert.ok(response && response.status() < 400, `home page HTTP ${response?.status()}`);
  // Mark the first-run tour as seen, then reload so it never mounts. This is
  // what a returning user's browser has, and it avoids racing the tour's
  // overlay while the client bundle hydrates.
  await page.evaluate(() => {
    try {
      localStorage.setItem("sa.intro.seen", "1");
    } catch {}
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  const launch = page.getByRole("button", { name: "Launch Agent Workspace" });
  await launch.waitFor({ state: "visible", timeout: 20_000 });
  for (let attempt = 0; attempt < 4; attempt++) {
    await launch.click().catch(() => undefined);
    try {
      await page.locator("textarea").first().waitFor({ state: "visible", timeout: 5_000 });
      return;
    } catch {
      // Hydration may not have attached the click handler yet; retry.
    }
  }
  throw new Error("workspace composer did not appear after Launch");
}

/** Poll the node channel until the server hands this computer a job. */
async function claimJob(page: Page, computerId: string, token: string): Promise<ClaimResponse["job"]> {
  const headers = { authorization: `Bearer ${token}`, "x-computer-id": computerId };
  for (let attempt = 0; attempt < 60; attempt++) {
    const res = await page.request.post("/api/computers/node", {
      headers,
      data: { action: "claim" },
    });
    assert.equal(res.status(), 200, `claim failed: HTTP ${res.status()}`);
    const body = (await res.json()) as ClaimResponse;
    if (body.job) return body.job;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

test(TEST_NAME, { skip: readOnly ? "prod mode is read-only" : false }, async () => {
  await runPageTest(TEST_NAME, async ({ page }) => {
    await openWorkspace(page);
    // 1. Settings > Computers: create a pairing code and show the command.
    await page.getByTestId("open-settings").click();
    await page.getByTestId("settings-tab-computers").click();
    await page.getByTestId("add-computer").click();

    const codeEl = page.getByTestId("pairing-code");
    await codeEl.waitFor({ state: "visible", timeout: 10_000 });
    const code = (await codeEl.innerText()).trim();
    assert.match(code, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    const command = (await page.getByTestId("install-command").innerText()).trim();
    assert.ok(command.includes(code), "install command carries the pairing code");
    assert.ok(command.includes("/api/computers/node/install"), "install command points at the real installer");
    await captureView(page, TEST_NAME, "pairing-code");

    // 2. The node redeems the code (what the one-line command does).
    const redeemed = await page.request.post("/api/computers/pair", {
      data: {
        code,
        machine: { name: "E2E Mac", os: "macos", arch: "arm64", cpuCores: 8, memoryMb: 16384, mode: "host" },
      },
    });
    assert.equal(redeemed.status(), 200);
    const { computer, nodeToken } = (await redeemed.json()) as {
      computer: { id: string; name: string };
      nodeToken: string;
    };
    assert.match(nodeToken, /^[a-f0-9]{64}$/);

    // 3. It appears online in the list, with OS/CPU/RAM and host mode.
    const row = page.locator(`[data-computer-id="${computer.id}"]`);
    await row.waitFor({ state: "visible", timeout: 15_000 });
    await row.locator('[data-testid="computer-online"][data-online="true"]').waitFor({ state: "visible", timeout: 10_000 });
    await row.getByText("macOS").first().waitFor({ state: "visible", timeout: 5_000 });
    await row.getByText(/8 vCPU/).waitFor({ state: "visible", timeout: 5_000 });
    await row.getByText(/16 GB RAM/).waitFor({ state: "visible", timeout: 5_000 });
    await row.getByText("host", { exact: true }).waitFor({ state: "visible", timeout: 5_000 });

    // Rename is a user decision and survives the node's heartbeats.
    await row.getByTestId("rename-computer").click();
    await page.getByLabel("Computer name").fill("E2E Build Box");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await row.getByText("E2E Build Box").waitFor({ state: "visible", timeout: 10_000 });
    await captureView(page, TEST_NAME, "paired-online");

    await page.keyboard.press("Escape");
    await page.getByTestId("settings-sheet").waitFor({ state: "hidden", timeout: 10_000 });

    // 4. The compute picker lives on the Agent tab.
    await page.getByTestId("open-settings").click();
    await page.getByTestId("settings-tab-agent").click();
    const picker = page.getByTestId("settings-compute");
    await picker.waitFor({ state: "visible", timeout: 10_000 });
    await picker.selectOption(`computer:${computer.id}`);
    assert.equal(await picker.inputValue(), `computer:${computer.id}`);
    await page.keyboard.press("Escape");

    const input = page.getByTestId("composer-input");
    await input.fill("Say hello from my own computer.");
    await input.press("Enter");

    // 5. The node claims the job, streams a line and completes it.
    const job = await claimJob(page, computer.id, nodeToken);
    assert.ok(job, "the BYOC run reached the computer");
    const headers = { authorization: `Bearer ${nodeToken}`, "x-computer-id": computer.id };
    const streamed = await page.request.post("/api/computers/node", {
      headers,
      data: {
        action: "event",
        runId: job.runId,
        event: { type: "assistant.text", text: "BYOC e2e: running on your computer." },
      },
    });
    assert.equal(streamed.status(), 200);
    const completed = await page.request.post("/api/computers/node", {
      headers,
      data: {
        action: "complete",
        runId: job.runId,
        result: { status: "finished", exitCode: 0, text: "BYOC e2e reply from the paired machine." },
      },
    });
    assert.equal(completed.status(), 200);
    await page.getByText("BYOC e2e reply from the paired machine.").first().waitFor({ state: "visible", timeout: 20_000 });
    await captureView(page, TEST_NAME, "byoc-run");

    // 6. Revoke removes it from the account and kills its token.
    await page.getByTestId("open-settings").click();
    await page.getByTestId("settings-tab-computers").click();
    const revokeRow = page.locator(`[data-computer-id="${computer.id}"]`);
    await revokeRow.waitFor({ state: "visible", timeout: 10_000 });
    page.once("dialog", (dialog) => void dialog.accept());
    await revokeRow.getByTestId("revoke-computer").click();
    await revokeRow.waitFor({ state: "hidden", timeout: 10_000 });

    const rejected = await page.request.post("/api/computers/node", {
      headers,
      data: { action: "heartbeat" },
    });
    assert.equal(rejected.status(), 401, "a revoked node token stops working immediately");
    await captureView(page, TEST_NAME, "revoked");
  });
});
