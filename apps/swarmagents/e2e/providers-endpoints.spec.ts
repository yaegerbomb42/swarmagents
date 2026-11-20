import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Page } from "playwright-core";
import { closeBrowser, mode, openWorkspace, runPageTest } from "./lib";

after(async () => {
  await closeBrowser();
});

const readOnly = mode() === "prod";
const TEST_NAME = "providers: add a custom endpoint, discover models and test the connection";

/** Minimal OpenAI-compatible server standing in for a custom endpoint. */
async function startMockProvider(): Promise<{
  server: Server;
  baseUrl: string;
  calls: string[];
  headerChecks: string[];
}> {
  const calls: string[] = [];
  const headerChecks: string[] = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method ?? "GET"} ${req.url ?? "/"}`);
    if (req.headers["x-e2e-token"] === "e2e-header") headerChecks.push(req.url ?? "/");
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/v1/models") {
      res.end(JSON.stringify({ object: "list", data: [{ id: "mock-chat" }, { id: "mock-vision" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.end(
          JSON.stringify({
            id: "chatcmpl-e2e",
            object: "chat.completion",
            model: "mock-chat",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "pong from the mock provider" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 5 },
          }),
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, calls, headerChecks };
}

async function enterProvidersTab(page: Page): Promise<void> {
  await openWorkspace(page);
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-tab-providers").click();
  await page.getByTestId("server-endpoints").waitFor({ state: "visible", timeout: 10_000 });
}

test(TEST_NAME, { skip: readOnly ? "prod mode is read-only" : false }, async () => {
  const { server, baseUrl, calls, headerChecks } = await startMockProvider();
  try {
    await runPageTest(TEST_NAME, async ({ page }) => {
      await enterProvidersTab(page);

      await page.getByTestId("endpoint-id").fill("e2e-mock");
      await page.getByTestId("endpoint-base-url").fill(baseUrl);
      await page.getByTestId("endpoint-auth").selectOption("none");
      await page.getByTestId("endpoint-model").fill("mock-chat");
      await page.getByTestId("endpoint-models").fill("mock-chat\nmock-vision");
      await page.getByTestId("endpoint-headers").fill("x-e2e-token: e2e-header");

      // 1. /models discovery through the real server route.
      await page.getByTestId("endpoint-list").click();
      const result = page.getByTestId("endpoint-result");
      await result.filter({ hasText: "Found 2 models" }).waitFor({ state: "visible", timeout: 15_000 });

      // 2. A tiny completion proves the base URL, style and model work.
      await page.getByTestId("endpoint-test").click();
      await result.filter({ hasText: "pong from the mock provider" }).waitFor({
        state: "visible",
        timeout: 15_000,
      });
      assert.ok(
        calls.some((call) => call === "GET /v1/models"),
        "discovery reached the mock /v1/models",
      );
      assert.ok(
        calls.some((call) => call.startsWith("POST /v1/chat/completions")),
        "the connection test reached the mock chat endpoint",
      );
      assert.ok(headerChecks.length >= 2, "extra static headers reached discovery and the test request");

      // 3. Save it as a server-side endpoint and confirm it is listed.
      await page.getByTestId("endpoint-save").click();
      await result.filter({ hasText: "Saved e2e-mock" }).waitFor({ state: "visible", timeout: 10_000 });

      const listed = await page.request.get("/api/providers");
      assert.equal(listed.status(), 200);
      const body = (await listed.json()) as {
        providers: Array<{ id: string; apiStyle?: string; baseUrl?: string; needsKey?: boolean }>;
      };
      const saved = body.providers.find((p) => p.id === "e2e-mock");
      assert.ok(saved, "saved endpoint is returned by /api/providers");
      assert.equal(saved.apiStyle, "openai-chat");
      assert.equal(saved.baseUrl, baseUrl);
      assert.equal(saved.needsKey, false);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
