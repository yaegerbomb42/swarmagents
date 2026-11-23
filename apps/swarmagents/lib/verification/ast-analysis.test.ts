import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeFile,
  analyzeSourceText,
  collectRelativeImports,
  countAssertionsInFiles,
  extractExpectations,
  isTestFilePath,
  isTypeScriptSourcePath,
  maxComplexityInFiles,
  parseTypeScript,
} from "./ast-analysis.js";

test("analyzeSourceText counts assertions and complexity for valid TypeScript", () => {
  const source = `
    import { expect, it } from 'vitest';
    it('adds', () => {
      expect(1 + 1).toBe(2);
      expect(true).toBe(true);
    });
  `;
  const analysis = analyzeSourceText(source, "add.test.ts");
  assert.deepEqual(analysis.syntaxErrors, []);
  assert.equal(analysis.assertionCount, 2);
  assert.ok(analysis.maxCyclomaticComplexity >= 1);
});

test("analyzeSourceText reports syntax errors instead of silently analysing a broken file", () => {
  const analysis = analyzeSourceText("export const = ;\nfunction (", "broken.ts");
  assert.ok(analysis.syntaxErrors.length > 0);
  assert.ok(analysis.syntaxErrors[0]?.message);
  assert.ok((analysis.syntaxErrors[0]?.line ?? 0) > 0);
});

test("analyzeSourceText re-parses JSX saved with a .ts extension as TSX", () => {
  const source = `
    export const Card = () => <div className="card">hello</div>;
    export const value = 1;
  `;
  const parsed = parseTypeScript(source, "Card.ts");
  assert.deepEqual(parsed.diagnostics, []);
  const analysis = analyzeSourceText(source, "Card.ts");
  assert.deepEqual(analysis.syntaxErrors, []);
});

test("analyzeSourceText handles TSX generics and nested JSX without diagnostics", () => {
  const source = `
    type Props = { items: string[] };
    export function List({ items }: Props) {
      return (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      );
    }
  `;
  assert.deepEqual(analyzeSourceText(source, "List.tsx").syntaxErrors, []);
});

test("analyzeSourceText detects skip/only markers and relative imports", () => {
  const source = `
    import { helper } from './helper';
    import { other } from 'some-package';
    describe.only('suite', () => {
      it.skip('skipped', () => { expect(1).toBe(1); });
    });
  `;
  const analysis = analyzeSourceText(source, "a.test.ts");
  assert.equal(analysis.hasSkipOrOnly, true);
  assert.deepEqual(analysis.relativeImports, ["./helper"]);
});

test("analyzeSourceText scores cyclomatic complexity per function", () => {
  const source = `
    export function branchy(a: boolean, b: boolean) {
      if (a && b) return 1;
      if (a || b) return 2;
      return 3;
    }
  `;
  const analysis = analyzeSourceText(source, "branchy.ts");
  // 1 base + if + && + if + || = 5
  assert.equal(analysis.maxCyclomaticComplexity, 5);
});

test("extractExpectations extracts literal expectations from TSX tests", () => {
  const source = `
    import { expect, it } from 'vitest';
    it('renders', () => {
      expect(render()).toBe('<div />');
      expect(count).not.toBe(0);
    });
  `;
  const found = extractExpectations(source, "render.test.tsx");
  assert.deepEqual(
    found.map((a) => a.matcher),
    ["toBe", "toBe"],
  );
  assert.equal(found[0]?.expected, "'<div />'");
  assert.equal(found[1]?.expected, "0");
  assert.equal(found[0]?.testTitle, "renders");
  assert.equal(found[0]?.actual, "render()");
});

test("extractExpectations tags assertions with the enclosing describe scope and line", () => {
  const source = [
    "describe('math', () => {",
    "  it('adds', () => {",
    "    expect(add(2, 3)).toBe(5);",
    "  });",
    "});",
  ].join("\n");
  const found = extractExpectations(source, "math.test.ts");
  assert.equal(found.length, 1);
  assert.equal(found[0]?.testTitle, "math › adds");
  assert.equal(found[0]?.line, 3);
  assert.equal(found[0]?.expected, "5");
});

test("extractExpectations skips non-literal expected values", () => {
  const source = `
    it('x', () => {
      expect(value).toBe(SOME_CONST);
      expect(other).toBe(42);
    });
  `;
  const found = extractExpectations(source, "x.test.ts");
  assert.equal(found.length, 1);
  assert.equal(found[0]?.expected, "42");
});

test("extractExpectations returns an empty list rather than throwing on unparseable input", () => {
  assert.doesNotThrow(() => extractExpectations('it("x", () => { expect(', "x.ts"));
  assert.deepEqual(extractExpectations('it("x", () => { expect(', "x.ts"), []);
});

test("analyzeFile surfaces an unreadable file as a diagnostic", () => {
  const analysis = analyzeFile(join(tmpdir(), `missing-${process.pid}-${Date.now()}.ts`));
  assert.equal(analysis.syntaxErrors.length, 1);
  assert.match(analysis.syntaxErrors[0]?.message ?? "", /cannot read/);
  assert.equal(analysis.assertionCount, 0);
});

test("file helpers aggregate across files on disk", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ast-analysis-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = join(dir, "a.test.ts");
  const b = join(dir, "b.ts");
  writeFileSync(a, "import { x } from './b';\nimport { y } from '../shared';\nexpect(x).toBe(1);\n");
  writeFileSync(b, "export function f(v: boolean) { if (v) return 1; return 2; }\n");
  assert.equal(countAssertionsInFiles([a, b]), 1);
  assert.equal(maxComplexityInFiles([a, b]), 2);
  assert.deepEqual(collectRelativeImports(a), ["./b", "../shared"]);
});

test("isTypeScriptSourcePath matches only TypeScript source extensions", () => {
  assert.equal(isTypeScriptSourcePath("a.ts"), true);
  assert.equal(isTypeScriptSourcePath("a.tsx"), true);
  assert.equal(isTypeScriptSourcePath("a.mts"), true);
  assert.equal(isTypeScriptSourcePath("a.js"), false);
  assert.equal(isTypeScriptSourcePath("README.md"), false);
});

test("isTestFilePath matches test and spec files", () => {
  assert.equal(isTestFilePath("a.test.ts"), true);
  assert.equal(isTestFilePath("a.spec.tsx"), true);
  assert.equal(isTestFilePath("a.test.js"), true);
  assert.equal(isTestFilePath("a.ts"), false);
  assert.equal(isTestFilePath("latest.ts"), false);
});

test("extractExpectations distinguishes negated expectations from positive ones", () => {
  const source = `
    it('sign', () => {
      expect(value).toBe(0);
      expect(value).not.toBe(0);
      expect(promise).resolves.not.toBe(null);
    });
  `;
  const found = extractExpectations(source, "sign.test.ts");
  assert.equal(found.length, 3);
  assert.equal(found[0]?.negated, false);
  assert.equal(found[1]?.negated, true);
  assert.equal(found[2]?.negated, true);
  assert.equal(found[2]?.modifier, "resolves");
  assert.notDeepEqual(
    { expected: found[0]?.expected, negated: found[0]?.negated },
    { expected: found[1]?.expected, negated: found[1]?.negated },
  );
});

test("extractExpectations accepts it.only scopes and template-literal titles", () => {
  const source = "it.only(`templated title`, () => { expect(1).toBe(1); });";
  const found = extractExpectations(source, "only.test.ts");
  assert.equal(found.length, 1);
  assert.equal(found[0]?.testTitle, "templated title");
});

test("extractExpectations only accepts fully literal arrays and objects", () => {
  const source = `
    it('shapes', () => {
      expect(a).toEqual({ x: 1, y: [2, 3] });
      expect(b).toEqual({ x: SOME_CONST });
      expect(c).toEqual([1, call()]);
    });
  `;
  const found = extractExpectations(source, "shapes.test.ts");
  assert.equal(found.length, 1);
  assert.equal(found[0]?.expected, "{ x: 1, y: [2, 3] }");
});

test("analyzeSourceText counts assert.strict.equal and ignores a bare expect without a matcher", () => {
  const source = `
    import assert from 'node:assert/strict';
    test('x', () => {
      assert.strict.equal(1, 1);
      assert.equal(2, 2);
      expect(3);
    });
  `;
  const analysis = analyzeSourceText(source, "asserts.test.ts");
  assert.equal(analysis.assertionCount, 2);
});

test("analyzeSourceText detects node:test option-object skip/only and chained markers", () => {
  const skipped = analyzeSourceText(
    `test('x', { skip: true }, () => { expect(1).toBe(1); });`,
    "skip.test.ts",
  );
  assert.equal(skipped.hasSkipOrOnly, true);

  const only = analyzeSourceText(
    `describe('d', () => { test('x', { only: true }, () => { expect(1).toBe(1); }); });`,
    "only.test.ts",
  );
  assert.equal(only.hasSkipOrOnly, true);

  const each = analyzeSourceText(
    `test.skip.each([[1], [2]])('x', () => { expect(1).toBe(1); });`,
    "each.test.ts",
  );
  assert.equal(each.hasSkipOrOnly, true);

  const todo = analyzeSourceText(`test.todo('later');`, "todo.test.ts");
  assert.equal(todo.hasSkipOrOnly, true);

  const plain = analyzeSourceText(`test('x', () => { expect(1).toBe(1); });`, "plain.test.ts");
  assert.equal(plain.hasSkipOrOnly, false);
});

test("analyzeSourceText scores constructors, accessors and static blocks as functions", () => {
  const source = `
    class Widget {
      constructor(flag: boolean) { if (flag) { this.flag = flag; } }
      get value() { if (this.flag) return 1; return 2; }
      set value(next: number) { if (next) { this.flag = Boolean(next); } }
      static { if (globalThis) { void 0; } }
    }
  `;
  const analysis = analyzeSourceText(source, "widget.ts");
  // Each member is its own function (2); without accessor/constructor/static
  // support their decisions would accumulate in the top-level score.
  assert.equal(analysis.maxCyclomaticComplexity, 2);
});

test("analyzeSourceText treats logical assignments as decisions", () => {
  const source = `
    export function merge(a: boolean, b: boolean) {
      let x = a;
      x &&= b;
      x ||= a;
      x ??= true;
      return x;
    }
  `;
  const analysis = analyzeSourceText(source, "merge.ts");
  // 1 base + three logical assignments
  assert.equal(analysis.maxCyclomaticComplexity, 4);
});

test("analyzeSourceText collects relative re-exports and dynamic imports", () => {
  const source = `
    export { a } from './a';
    export * from '../shared';
    export const lazy = () => import('./lazy');
    export { b } from 'some-package';
  `;
  const analysis = analyzeSourceText(source, "index.ts");
  assert.deepEqual(analysis.relativeImports, ["./a", "../shared", "./lazy"]);
});
