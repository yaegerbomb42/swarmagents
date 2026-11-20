import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureProviderStorePaths } from "../providers/store";
import {
  MINILM_MODEL,
  MINILM_MODEL_PREFIX,
  cosineSimilarity,
  embedText,
  embedTextWithModel,
  embeddingCandidates,
  meanPoolAndNormalize,
} from "./embeddings";

const USER = "local_embed@example.com";
let tempDir: string;
const savedEnv: Record<string, string | undefined> = {};

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-embed-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
  // The tests must never reach the network: no provider key, no endpoint.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("SWARM_KEYS_") || name.startsWith("SWARM_EMBEDDING_")) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
  }
});

test.afterEach(() => {
  configureProviderStorePaths("");
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

test("without a configured provider there is no embedding candidate", () => {
  assert.deepEqual(embeddingCandidates(USER), []);
});

test("an explicit embedding endpoint is used as a candidate", () => {
  process.env.SWARM_EMBEDDING_URL = "http://127.0.0.1:9/v1/embeddings";
  process.env.SWARM_EMBEDDING_MODEL = "text-embedding-3-small";
  const candidates = embeddingCandidates(USER);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, "http://127.0.0.1:9/v1/embeddings");
  assert.equal(candidates[0].model, "text-embedding-3-small");
});

test("embedText gives up (returns null) when no embedder is reachable", async () => {
  assert.equal(await embedText(USER, "prefers pnpm"), null);
  assert.equal(await embedTextWithModel(USER, "prefers pnpm", "openai:text-embedding-3-small"), null);
});

test("cosine similarity behaves like cosine similarity", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.ok(cosineSimilarity([1, 1], [-1, -1]) < 0);
  assert.equal(cosineSimilarity([], [1]), 0);
});

test("mean pooling averages the rows and normalizes the result", () => {
  const pooled = meanPoolAndNormalize([
    [1, 0],
    [0, 1],
  ]);
  assert.equal(pooled.length, 2);
  const norm = Math.sqrt(pooled[0] ** 2 + pooled[1] ** 2);
  assert.ok(Math.abs(norm - 1) < 1e-9);
  assert.deepEqual(meanPoolAndNormalize([]), []);
});

test("the local MiniLM model id is namespaced", () => {
  assert.equal(MINILM_MODEL_PREFIX, "minilm:");
  assert.ok(MINILM_MODEL.length > 0);
});
