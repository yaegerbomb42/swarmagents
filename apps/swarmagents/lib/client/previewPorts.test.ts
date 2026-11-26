import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PREVIEW_PORTS_ENDPOINT,
  fetchListeningPorts,
  pickPrimaryPreviewPort,
  previewHrefForPort,
} from "./previewPorts";

test("pickPrimaryPreviewPort prefers common web dev ports then lowest port", () => {
  assert.equal(pickPrimaryPreviewPort([]), null);
  assert.equal(pickPrimaryPreviewPort([9222, 5173, 3000]), 3000);
  assert.equal(pickPrimaryPreviewPort([9222, 5173]), 5173);
  assert.equal(pickPrimaryPreviewPort([9222, 4567]), 4567);
});

test("previewHrefForPort builds the session-gated preview path", () => {
  assert.equal(previewHrefForPort(3000), "/preview/3000/");
});

test("fetchListeningPorts parses valid ports and fails closed on errors", async () => {
  let seenUrl = "";
  const okFetch = (async (url: string | URL | Request) => {
    seenUrl = String(url);
    return new Response(JSON.stringify({ running: true, ports: [3000, "bad", 5173] }), { status: 200 });
  }) as typeof fetch;
  const res = await fetchListeningPorts(okFetch);
  assert.equal(seenUrl, PREVIEW_PORTS_ENDPOINT);
  assert.deepEqual(res, { running: true, ports: [3000, 5173] });

  const errFetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  assert.deepEqual(await fetchListeningPorts(errFetch), { running: false, ports: [] });

  const throwFetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  assert.deepEqual(await fetchListeningPorts(throwFetch), { running: false, ports: [] });
});
