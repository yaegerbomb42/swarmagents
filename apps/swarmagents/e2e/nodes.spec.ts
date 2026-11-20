/**
 * End-to-end test for Settings → Nodes.
 *
 * A real `swarm-node` process pairs with the app's in-process BYOC hub using
 * the one-time code the panel created. The machine shows up as online and,
 * when the account revokes it, the live session is killed and the runner
 * stops.
 *
 * The node runs in its default container mode (it never has to receive a
 * command here, so Docker does not have to be running) so the test exercises
 * the path a real user takes. The command/desktop path is covered by
 * `byoc.spec.ts`.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { UISkipError, captureView, closeBrowser, mode, runPageTest } from "./lib";

const TEST_NAME = "nodes: pair a BYOC node from Settings, see it online, then revoke it";
const APP_ROOT = path.resolve(__dirname, "..");
const TSX = path.join(APP_ROOT, "node_modules", ".bin", "tsx");
const NODE_CLI = path.join(APP_ROOT, "packages", "swarm-node", "src", "cli.ts");

/** True when something accepts TCP connections on the loopback port. */
function canConnect(port: number, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** Enter the workspace from a cold browser context. */
async function enterWorkspace(page: Page): Promise<void> {
  const response = await page.goto("/", { waitUntil: "domcontentloaded" });
  assert.ok(response && response.status() < 400, `home page HTTP ${response?.status()}`);
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

test(TEST_NAME, { skip: mode() === "prod" ? "prod mode is read-only" : false }, async () => {
  await runPageTest(TEST_NAME, async ({ page }) => {
    const hubPort = Number(process.env.SWARM_BYOC_PORT ?? 3779);
    const hubUrl = process.env.SWARM_BYOC_E2E_URL ?? `ws://127.0.0.1:${hubPort}/byoc/ws`;
    if (!(await canConnect(hubPort))) {
      throw new UISkipError(
        `UI skipped: the BYOC hub is not listening on 127.0.0.1:${hubPort}. Start the app with the in-process hub enabled (do not set SWARM_BYOC_DISABLED=1).`,
      );
    }

    await enterWorkspace(page);
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    await page.getByRole("tab", { name: "Nodes" }).click();
    await page.getByTestId("byoc-nodes").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("byoc-empty").waitFor({ state: "visible", timeout: 10_000 });

    // The panel hands out a one-time pairing code and the command to run.
    await page.getByTestId("byoc-create-code").click();
    const codeEl = page.getByTestId("byoc-pairing-code");
    await codeEl.waitFor({ state: "visible", timeout: 10_000 });
    const code = (await codeEl.innerText()).trim();
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const command = (await page.getByTestId("byoc-pairing-command").innerText()).trim();
    assert.ok(command.includes(code), "the command carries the pairing code");
    assert.ok(command.includes("swarm-node"), "the command runs the runner");
    await captureView(page, TEST_NAME, "pairing-code");

    // A real runner pairs with the app's hub using that code.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-node-e2e-"));
    const child: ChildProcess = spawn(
      TSX,
      [
        NODE_CLI,
        "--server",
        hubUrl,
        "--pair",
        code,
        "--name",
        "E2E Node",
        "--state",
        path.join(stateDir, "credentials.json"),
      ],
      {
        cwd: APP_ROOT,
        env: { ...process.env, SWARM_NODE_HOME: path.join(stateDir, "home") },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let nodeLog = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      nodeLog += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      nodeLog += chunk.toString("utf8");
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

    try {
      // The panel polls the account; once the runner connects the row says
      // online and shows that it is in container mode.
      const row = page.locator('[data-testid="byoc-node-row"]').first();
      await row.waitFor({ state: "visible", timeout: 45_000 });
      await page
        .locator('[data-testid="byoc-node-online"][data-online="true"]')
        .waitFor({ state: "visible", timeout: 45_000 });
      await row.getByText("E2E Node").waitFor({ state: "visible", timeout: 5_000 });
      await row.getByText(/container/).waitFor({ state: "visible", timeout: 5_000 });
      await captureView(page, TEST_NAME, "paired-online");

      // Revoking kills the live session; the runner sees it and stops.
      await row.getByTestId("byoc-revoke").click();
      await page.getByTestId("byoc-empty").waitFor({ state: "visible", timeout: 20_000 });
      const exitCode = await Promise.race([
        exited,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 20_000)),
      ]);
      assert.notEqual(exitCode, "timeout", `the runner did not stop after revocation:\n${nodeLog}`);
      assert.equal(exitCode, 0, `the runner exited with ${exitCode}:\n${nodeLog}`);
      await captureView(page, TEST_NAME, "revoked");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
  });
});

test.after(async () => {
  await closeBrowser();
});
