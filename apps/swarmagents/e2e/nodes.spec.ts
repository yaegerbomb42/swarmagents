/**
 * End-to-end test for BYOC node pairing.
 *
 * A real `swarm-node` process pairs with the app's in-process BYOC hub using
 * a one-time code from the pair API. The node shows up as online and, when
 * the account revokes it, the live session is killed and the runner stops.
 *
 * The node runs in its default container mode (it never has to receive a
 * command here, so Docker does not have to be running) so the test exercises
 * the path a real user takes. The command/desktop path is covered by
 * `byoc.spec.ts`.
 *
 * The pairing used to go through the Settings → Nodes tab, but that panel
 * (ByocNodes) is unmounted dead code — the Nodes tab no longer exists — so
 * the spec drives the same pair API the panel used (POST/GET/DELETE
 * /api/byoc/pair). The node UI itself is covered by `computers.spec.ts`.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { UISkipError, closeBrowser, mode, openWorkspace, runPageTest } from "./lib";

const TEST_NAME = "nodes: pair a BYOC node, see it online, then revoke it";
const APP_ROOT = path.resolve(__dirname, "..");
const TSX = path.join(APP_ROOT, "node_modules", ".bin", "tsx");
const NODE_CLI = path.join(APP_ROOT, "packages", "swarm-node", "src", "cli.ts");

interface ByocNodeRow {
  id: string;
  name: string;
  online: boolean;
  hostMode: boolean;
  revokedAt: number | null;
}

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

/** The account's nodes, via the pair API the old panel used. */
async function listNodes(page: Page): Promise<ByocNodeRow[]> {
  const res = await page.request.get("/api/byoc/pair");
  assert.ok(res.ok(), `node list failed: HTTP ${res.status()}`);
  const body = (await res.json()) as { nodes?: ByocNodeRow[] };
  return Array.isArray(body.nodes) ? body.nodes : [];
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

    await openWorkspace(page);

    // The pair API hands out a one-time pairing code and the command to run.
    const created = await page.request.post("/api/byoc/pair", { data: {} });
    assert.ok(created.ok(), `pairing code creation failed: HTTP ${created.status()}`);
    const { code, command } = (await created.json()) as { code: string; command: string };
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.ok(command.includes(code), "the command carries the pairing code");
    assert.ok(command.includes("swarm-node"), "the command runs the runner");

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
      // Poll the account until the runner connects: the node says online
      // and is in container mode (no --host-mode flag was passed).
      let deviceId = "";
      const start = Date.now();
      for (;;) {
        const row = (await listNodes(page)).find((n) => n.name === "E2E Node");
        if (row?.online) {
          deviceId = row.id;
          assert.equal(row.hostMode, false, "expected container mode");
          break;
        }
        if (Date.now() - start > 45_000) throw new Error(`the runner did not come online:\n${nodeLog}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Revoking kills the live session; the runner sees it and stops.
      const revoked = await page.request.delete(`/api/byoc/pair?deviceId=${encodeURIComponent(deviceId)}`);
      assert.ok(revoked.ok(), `revoke failed: HTTP ${revoked.status()}`);
      const goneStart = Date.now();
      for (;;) {
        const row = (await listNodes(page)).find((n) => n.id === deviceId);
        if (row && !row.online && row.revokedAt !== null) break;
        if (Date.now() - goneStart > 20_000) throw new Error(`the node did not go offline after revocation:\n${nodeLog}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const exitCode = await Promise.race([
        exited,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 20_000)),
      ]);
      assert.notEqual(exitCode, "timeout", `the runner did not stop after revocation:\n${nodeLog}`);
      assert.equal(exitCode, 0, `the runner exited with ${exitCode}:\n${nodeLog}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
  });
});

test.after(async () => {
  await closeBrowser();
});
