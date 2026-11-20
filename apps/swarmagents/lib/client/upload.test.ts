/**
 * Unit tests for the client upload helpers (lib/client/upload.ts).
 *
 * The upload call itself is exercised with an injected fetch; the route-level
 * behavior (auth, limits, traversal) is covered by
 * app/api/runtime/vm/files/upload/route.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_FILE_BYTES,
  UPLOAD_ENDPOINT,
  UploadError,
  uploadAttachments,
  validateAttachment,
  type PendingAttachment,
  type UploadResult,
} from "./upload";

function file(name: string, content: string, type = "text/plain"): File {
  return new File([new TextEncoder().encode(content)], name, { type });
}

function pending(name: string, content: string, type?: string): PendingAttachment {
  const f = file(name, content, type);
  return { name, size: f.size, type: f.type, file: f };
}

function okFetch(overrides: Partial<UploadResult> = {}): ReturnType<typeof fetch> {
  const result: UploadResult = {
    uploadDir: "/workspace/uploads",
    uploaded: [{ name: "a.txt", path: "/workspace/uploads/a.txt", size: 5, type: "text/plain" }],
    ...overrides,
  };
  return Promise.resolve(new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

test("validateAttachment: rejects over-limit counts and sizes", () => {
  assert.equal(validateAttachment({ name: "a.txt", size: 10 }, MAX_UPLOAD_FILES), `Maximum ${MAX_UPLOAD_FILES} files per message.`);
  assert.equal(validateAttachment({ name: "big.bin", size: MAX_UPLOAD_FILE_BYTES + 1 }, 0), '"big.bin" is larger than 10 MB.');
  assert.equal(validateAttachment({ name: "ok.txt", size: MAX_UPLOAD_FILE_BYTES }, 0), null);
  assert.equal(validateAttachment({ name: "ok.txt", size: 10 }, 0), null);
});

test("uploadAttachments posts multipart form data to the endpoint", async () => {
  let calledUrl = "";
  let calledBody: FormData | undefined;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calledUrl = url;
    calledBody = init?.body as FormData;
    return okFetch();
  }) as typeof fetch;

  const result = await uploadAttachments([pending("a.txt", "hello")], { fetchImpl });
  assert.equal(calledUrl, UPLOAD_ENDPOINT);
  assert.equal(result.uploaded[0].path, "/workspace/uploads/a.txt");
  const f = calledBody?.get("files") as File | null;
  assert.ok(f instanceof File);
  assert.equal(f?.name, "a.txt");
  assert.equal(await f?.text(), "hello");
});

test("uploadAttachments attaches every file under the files field", async () => {
  const names: string[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const form = init?.body as FormData;
    for (const entry of form.getAll("files")) names.push((entry as File).name);
    return okFetch();
  }) as typeof fetch;

  await uploadAttachments([pending("a.txt", "1"), pending("b.png", "2", "image/png")], { fetchImpl });
  assert.deepEqual(names, ["a.txt", "b.png"]);
});

test("uploadAttachments surfaces server errors as UploadError with status", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: "Too many files: at most 10 per message.", code: "too_many_files" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  await assert.rejects(
    uploadAttachments([pending("a.txt", "1")], { fetchImpl }),
    (err: unknown) => {
      assert.ok(err instanceof UploadError);
      assert.equal(err.status, 400);
      assert.equal(err.code, "too_many_files");
      assert.match(err.message, /Too many files/);
      return true;
    },
  );
});

test("uploadAttachments converts network failures into UploadError", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  await assert.rejects(
    uploadAttachments([pending("a.txt", "1")], { fetchImpl }),
    (err: unknown) => err instanceof UploadError && err.code === "network",
  );
});

test("uploadAttachments propagates abort errors untouched", async () => {
  const fetchImpl = (async () => {
    const err = new DOMException("The operation was aborted.", "AbortError");
    throw err;
  }) as typeof fetch;

  await assert.rejects(
    uploadAttachments([pending("a.txt", "1")], { fetchImpl }),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
});

test("uploadAttachments rejects malformed success payloads", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ nope: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  await assert.rejects(
    uploadAttachments([pending("a.txt", "1")], { fetchImpl }),
    (err: unknown) => err instanceof UploadError && err.code === "malformed",
  );
});
