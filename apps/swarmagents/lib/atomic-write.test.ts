/**
 * Tests for the shared atomic writer (lib/atomic-write.ts).
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile, atomicWriteFileAsync } from "./atomic-write";

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarmagents-atomic-write-"));
}

test("atomicWriteFile: writes content and replaces the target in one rename", () => {
  const dir = makeDir();
  const file = path.join(dir, "store.json");
  atomicWriteFile(file, JSON.stringify({ a: 1 }, null, 2));
  assert.equal(fs.readFileSync(file, "utf-8"), JSON.stringify({ a: 1 }, null, 2));
  assert.deepEqual(fs.readdirSync(dir), ["store.json"], "no temp file left behind");

  atomicWriteFile(file, "second");
  assert.equal(fs.readFileSync(file, "utf-8"), "second");
  assert.deepEqual(fs.readdirSync(dir), ["store.json"]);
});

test("atomicWriteFile: honors the requested mode", () => {
  const dir = makeDir();
  const file = path.join(dir, "secret.json");
  atomicWriteFile(file, "{}", { mode: 0o600 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("atomicWriteFile: validate hook sees the temp bytes before the rename", () => {
  const dir = makeDir();
  const file = path.join(dir, "store.json");
  let validated: string | undefined;
  atomicWriteFile(file, JSON.stringify({ ok: true }), {
    validate: (tmpPath) => {
      validated = fs.readFileSync(tmpPath, "utf-8");
      JSON.parse(validated); // throws on malformed JSON
    },
  });
  assert.equal(validated, JSON.stringify({ ok: true }));
  assert.equal(fs.readFileSync(file, "utf-8"), JSON.stringify({ ok: true }));
});

test("atomicWriteFile: a failing validate leaves the target untouched and removes the temp file", () => {
  const dir = makeDir();
  const file = path.join(dir, "store.json");
  fs.writeFileSync(file, "original");
  assert.throws(
    () => atomicWriteFile(file, "not json", { validate: (tmpPath) => JSON.parse(fs.readFileSync(tmpPath, "utf-8")) }),
    /Unexpected token/,
  );
  assert.equal(fs.readFileSync(file, "utf-8"), "original");
  assert.deepEqual(fs.readdirSync(dir), ["store.json"]);
});

test("atomicWriteFile: accepts a Buffer", () => {
  const dir = makeDir();
  const file = path.join(dir, "bin.dat");
  atomicWriteFile(file, Buffer.from([0x00, 0x01, 0x02]));
  assert.deepEqual([...fs.readFileSync(file)], [0x00, 0x01, 0x02]);
});

test("atomicWriteFileAsync: writes, fsyncs and renames; a failing validate aborts", async () => {
  const dir = makeDir();
  const file = path.join(dir, "store.json");
  await atomicWriteFileAsync(file, JSON.stringify({ a: 1 }), { mode: 0o600 });
  assert.equal(fs.readFileSync(file, "utf-8"), JSON.stringify({ a: 1 }));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ["store.json"]);

  await assert.rejects(
    () => atomicWriteFileAsync(file, "bad", { validate: async (tmpPath) => JSON.parse(fs.readFileSync(tmpPath, "utf-8")) }),
    /Unexpected token/,
  );
  assert.equal(fs.readFileSync(file, "utf-8"), JSON.stringify({ a: 1 }));
  assert.deepEqual(fs.readdirSync(dir), ["store.json"]);
});
