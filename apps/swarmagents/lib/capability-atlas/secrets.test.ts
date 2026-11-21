import assert from "node:assert/strict";
import { describe, it } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { scanAiProviders } from "./discovery/providers-scanner";
import { RegistryStore } from "./registry/store";

describe("Secret safety", () => {
  it("never stores or serializes any API key secret value in the registry", async () => {
    const fakeSecrets = {
      OPENAI_API_KEY: "sk-proj-SUPER_SECRET_OPENAI_VALUE_99999",
      ANTHROPIC_API_KEY: "sk-ant-SUPER_SECRET_ANTHROPIC_VALUE_88888",
      GEMINI_API_KEY: "AIzaSySUPER_SECRET_GEMINI_VALUE_77777",
      GROQ_API_KEY: "gsk_SUPER_SECRET_GROQ_VALUE_66666",
    };

    const entries = await scanAiProviders({
      verify: false,
      env: fakeSecrets,
    });

    assert.equal(entries.length, 4);

    const tmpFile = path.join(
      os.tmpdir(),
      `capability-atlas-secret-test-${Date.now()}.json`
    );
    const store = new RegistryStore(tmpFile);
    await store.save(entries);

    const rawFile = await fs.readFile(tmpFile, "utf8");
    await fs.unlink(tmpFile);

    for (const secretVal of Object.values(fakeSecrets)) {
      assert.ok(!rawFile.includes(secretVal));
    }
    assert.ok(rawFile.includes("OPENAI_API_KEY"));
  });
});
