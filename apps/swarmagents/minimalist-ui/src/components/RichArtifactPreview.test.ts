import { test } from "node:test";
import assert from "node:assert/strict";
import {
  artifactRichRenderer,
  buildSandboxedHtmlSrcDoc,
  parseCsvRows,
  sortCsvRows,
} from "./RichArtifactPreview";

test("artifactRichRenderer maps supported extensions", () => {
  assert.equal(artifactRichRenderer("index.html"), "html");
  assert.equal(artifactRichRenderer("page.HTM"), "html");
  assert.equal(artifactRichRenderer("data.csv"), "csv");
  assert.equal(artifactRichRenderer("data.tsv"), "csv");
  assert.equal(artifactRichRenderer("report.pdf"), "pdf");
  assert.equal(artifactRichRenderer("chart.svg"), "svg");
  assert.equal(artifactRichRenderer("notes.md"), null);
});

test("parseCsvRows handles quoted fields, escaped quotes, and row cap", () => {
  const csv = 'name,note,score\n"Ada, Lovelace","said ""hi""",99\nGrace,ok,42\nAlan,math,88\n';
  const parsed = parseCsvRows(csv, 2);
  assert.deepEqual(parsed.headers, ["name", "note", "score"]);
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows[0], ["Ada, Lovelace", 'said "hi"', "99"]);
  assert.equal(parsed.truncated, true);
});

test("sortCsvRows sorts numerically when values are numbers and lexically otherwise", () => {
  const rows = [
    ["bob", "10"],
    ["ada", "2"],
    ["carl", "100"],
  ];
  assert.deepEqual(
    sortCsvRows(rows, 1, "asc").map((r) => r[0]),
    ["ada", "bob", "carl"],
  );
  assert.deepEqual(
    sortCsvRows(rows, 1, "desc").map((r) => r[0]),
    ["carl", "bob", "ada"],
  );
  assert.deepEqual(
    sortCsvRows(rows, 0, "asc").map((r) => r[0]),
    ["ada", "bob", "carl"],
  );
});

test("buildSandboxedHtmlSrcDoc injects strict CSP into head or fragment", () => {
  const fullDoc = "<!doctype html><html><head><title>x</title></head><body>hi</body></html>";
  const wrappedFull = buildSandboxedHtmlSrcDoc(fullDoc);
  assert.ok(wrappedFull.includes("Content-Security-Policy"));
  assert.ok(wrappedFull.includes("default-src 'none'"));

  const frag = "<div>hello</div>";
  const wrappedFrag = buildSandboxedHtmlSrcDoc(frag);
  assert.ok(wrappedFrag.startsWith("<!doctype html>"));
  assert.ok(wrappedFrag.includes("<div>hello</div>"));
  assert.ok(wrappedFrag.includes("form-action 'none'"));
});
