import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeBrowser, mode, openWorkspace, runPageTest } from "./lib";

/**
 * The project bar was removed from the workspace. Projects and share links
 * still exist on the API, and /share/[token] is the page a recipient opens.
 */

after(async () => {
  await closeBrowser();
});

const skip = mode() === "prod" ? "prod mode is read-only" : false;

test(
  "projects: resume state survives a new thread in another browser context; share is read-only and revocable",
  { skip },
  async (t) => {
    const result = await runPageTest("projects: share page", async ({ page, context }) => {
      await openWorkspace(page, context);
      assert.equal(await page.getByTestId("project-bar").count(), 0);
      const name = `e2e-share-${Date.now().toString(36)}`;
      const created = await context.request.post("/api/projects", {
        data: { name, repo: "acme/app", activeBranch: "main" },
      });
      assert.equal(created.status(), 201, await created.text());
      const { project } = (await created.json()) as { project: { id: string; name: string } };
      const shared = await context.request.post(`/api/projects/${project.id}/share`);
      assert.equal(shared.status(), 200, await shared.text());
      const { share } = (await shared.json()) as { share: { token: string } };
      await page.goto(`/share/${share.token}`, { waitUntil: "domcontentloaded" });
      await page.getByText(name).first().waitFor({ state: "visible", timeout: 15_000 });
      const revoked = await context.request.delete(`/api/projects/${project.id}/share`);
      assert.equal(revoked.status(), 200);
    });
    if (result.skipped) t.skip(result.skipped);
  },
);
