/**
 * Tests for the L1 context packer's slicer (lib/harness/context/astSlicer.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { estimateTokens } from "../../codebase/tokens";
import {
  applySlicePatch,
  buildSkeleton,
  buildWorkingSet,
  getFileOutline,
  mergeRanges,
  outlineSymbols,
  readSlice,
  SlicePatchError,
  type SourceFile,
} from "./astSlicer";

const SAMPLE = [
  'import { x } from "./x";',
  "",
  "export interface Options {",
  "  a: number;",
  "}",
  "",
  "export async function run(opts: Options): Promise<void> {",
  "  return;",
  "}",
  "",
  "function helper() {",
  "  return 1;",
  "}",
  "",
  "export class Thing {",
  "  method() {}",
  "}",
  "export const VALUE = 3;",
  "type Local = string;",
].join("\n");

/** A deterministic synthetic TypeScript file of `fns` functions. */
function bigFile(path: string, fns: number): SourceFile {
  const lines: string[] = [`// ${path}`];
  for (let i = 0; i < fns; i++) {
    lines.push(`export function ${path.replace(/\W/g, "_")}_fn${i}(input: number): number {`);
    for (let j = 0; j < 8; j++) lines.push(`  const v${j} = input * ${j} + ${i}; // step ${j} of fn${i}`);
    lines.push("  return v7;", "}", "");
  }
  return { path, content: lines.join("\n") };
}

test("outlineSymbols finds declarations with line numbers and export flags", () => {
  const symbols = outlineSymbols(SAMPLE);
  assert.deepEqual(
    symbols.map((s) => [s.line, s.exported]),
    [
      [3, true],
      [7, true],
      [11, false],
      [15, true],
      [18, true],
      [19, false],
    ],
  );
  assert.match(symbols[1].signature, /^export async function run/);
});

test("getFileOutline renders a header and L<n> rows, and caps the symbol count", () => {
  const outline = getFileOutline({ path: "src/a.ts", content: SAMPLE });
  assert.match(outline, /^File: src\/a\.ts \(19 lines\)/);
  assert.match(outline, /L7: export async function run/);

  const capped = getFileOutline(bigFile("b.ts", 50), 35);
  assert.doesNotMatch(capped, /const v0/, "indented locals are not outline symbols");
  assert.equal(capped.split("\n").filter((l) => /^L\d+:/.test(l)).length, 35);
  assert.match(capped, /… 15 more symbols/);

  assert.match(getFileOutline({ path: "x.md", content: "hello\nworld" }), /no major symbols/);
});

test("readSlice numbers lines and clamps out-of-range windows", () => {
  const slice = readSlice({ path: "a.ts", content: SAMPLE }, 7, 9);
  assert.equal(slice.content, "7 | export async function run(opts: Options): Promise<void> {\n8 |   return;\n9 | }");
  assert.equal(slice.totalLines, 19);
  const clamped = readSlice({ path: "a.ts", content: SAMPLE }, -5, 500);
  assert.equal(clamped.startLine, 1);
  assert.equal(clamped.endLine, 19);
});

test("applySlicePatch replaces exactly one exact match and leaves $ sequences literal", () => {
  const out = applySlicePatch(SAMPLE, "  return 1;", "  return '$&$1';");
  assert.match(out, /return '\$&\$1';/);
  assert.equal(out.split("\n").length, SAMPLE.split("\n").length);
});

test("applySlicePatch tolerates indentation drift via line-normalized matching", () => {
  const out = applySlicePatch(SAMPLE, "function helper() {\nreturn 1;\n}", "function helper() {\n  return 2;\n}");
  assert.match(out, /return 2;/);
  assert.doesNotMatch(out, /return 1;/);
});

test("applySlicePatch refuses missing, ambiguous and empty targets", () => {
  assert.throws(() => applySlicePatch(SAMPLE, "nope()", "x"), (e: unknown) => e instanceof SlicePatchError && e.reason === "not_found");
  assert.throws(() => applySlicePatch("a\nb\na\n", "a", "x"), (e: unknown) => e instanceof SlicePatchError && e.reason === "ambiguous");
  assert.throws(
    () => applySlicePatch("  a\nb\n    a\n", "a ", "x"),
    (e: unknown) => e instanceof SlicePatchError && e.reason === "ambiguous",
  );
  assert.throws(() => applySlicePatch(SAMPLE, "   ", "x"), (e: unknown) => e instanceof SlicePatchError && e.reason === "empty_target");
});

test("mergeRanges merges overlap/adjacency and clamps", () => {
  assert.deepEqual(
    mergeRanges(
      [
        { start: 10, end: 20 },
        { start: -3, end: 2 },
        { start: 21, end: 25 },
        { start: 40, end: 30 },
        { start: 90, end: 120 },
      ],
      100,
    ),
    [
      { start: 1, end: 2 },
      { start: 10, end: 25 },
      { start: 30, end: 40 },
      { start: 90, end: 100 },
    ],
  );
});

test("buildSkeleton fits the cap and degrades full → exported → headers → dropped", () => {
  const files = [bigFile("a.ts", 30), bigFile("b.ts", 30), bigFile("c.ts", 30)];
  const full = buildSkeleton(files, 100_000);
  assert.equal(full.omitted.length, 0);
  assert.match(full.text, /L\d+: export function a_ts_fn0/);

  const partial = buildSkeleton(files, 300);
  assert.ok(partial.tokens <= 300);
  assert.match(partial.text, /L\d+: export function c_ts_fn0/);
  assert.match(partial.text, /… \d+ more/);

  const headersOnly = buildSkeleton(files, 30);
  assert.ok(headersOnly.tokens <= 30);
  assert.doesNotMatch(headersOnly.text, /L\d+:/);
  assert.match(headersOnly.text, /File: a\.ts/);

  const tiny = buildSkeleton(files, 12);
  assert.ok(tiny.tokens <= 12);
  assert.ok(tiny.omitted.length >= 1);
  assert.equal(tiny.included.length + tiny.omitted.length, 3);

  const exportedOnly = buildSkeleton(
    [{ path: "s.ts", content: SAMPLE + "\n" + Array.from({ length: 40 }, (_, i) => `function local${i}() {}`).join("\n") }],
    90,
  );
  assert.ok(exportedOnly.tokens <= 90);
  assert.match(exportedOnly.text, /export async function run/);
  assert.doesNotMatch(exportedOnly.text, /local0/);
});

test("buildWorkingSet shows whole files when they fit, focus windows when not, never over the cap", () => {
  const small: SourceFile = { path: "small.ts", content: SAMPLE };
  const big = bigFile("big.ts", 200); // ~2,200 lines
  const res = buildWorkingSet([small, { ...big, focus: [{ start: 1000, end: 1004 }] }], 1200);
  assert.ok(res.tokens <= 1200, `tokens ${res.tokens}`);
  assert.equal(res.tokens, estimateTokens(res.text));
  assert.deepEqual(res.included[0], { path: "small.ts", ranges: [{ start: 1, end: 19 }], totalLines: 19 });
  const bigRanges = res.included[1].ranges;
  assert.ok(bigRanges[0].start <= 1000 && bigRanges[0].end >= 1004, JSON.stringify(bigRanges));
  assert.match(res.text, /### big\.ts \(L\d+-\d+ of 2401\)/);
  assert.match(res.text, /1002 \| /);
});

test("buildWorkingSet orders by priority, falls back to a head window, and reports omissions", () => {
  const a = bigFile("a.ts", 100);
  const b = bigFile("b.ts", 100);
  const res = buildWorkingSet([{ ...a, priority: 0 }, { ...b, priority: 5 }], 300);
  assert.ok(res.tokens <= 300);
  assert.equal(res.included[0].path, "b.ts");
  assert.equal(res.included[0].ranges[0].start, 1);
  assert.ok(res.included[0].ranges[0].end < 1101);
  assert.deepEqual(res.omitted, ["a.ts"]);

  const none = buildWorkingSet([a], 0);
  assert.equal(none.text, "");
  assert.deepEqual(none.omitted, ["a.ts"]);
});
