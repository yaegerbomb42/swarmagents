import { readFileSync } from "node:fs";
import ts from "typescript";

/**
 * Shared low-level plumbing for the autonomous daemon's verification modules:
 * TypeScript AST analysis (assertion counting, skip/only detection, cyclomatic
 * complexity, import collection) and expected-value extraction.
 *
 * Ported from the standalone engine (`packages/engine/src/autonomous/ast-analysis.ts`).
 * The execa-based command runner (`defaultRunCommand` / `RunCommand`) was deliberately
 * left out: `execa` is not a dependency of this app, and the pure analysis is all
 * the verification pipeline needs here.
 */

// ---------------------------------------------------------------------------
// AST analysis (TypeScript compiler API — no ts-morph dependency in this repo)
// ---------------------------------------------------------------------------

export interface SourceAnalysis {
  /** Calls to expect(...) / assert(...) (including expect(x).toBe, assert.ok, …). */
  assertionCount: number;
  /** Any `.skip` / `.only` / xdescribe / xit / fit marker. */
  hasSkipOrOnly: boolean;
  /** Highest per-function cyclomatic complexity (1 + decision points). */
  maxCyclomaticComplexity: number;
  /** Raw relative import specifiers (`./…` / `../…`). */
  relativeImports: string[];
  /**
   * TypeScript syntax errors found while parsing. Empty for valid code. The compiler API is
   * error-tolerant, so analysis of a corrupt file used to succeed with partial counts — a
   * silently wrong gate. Callers that can fail a task should report these to the agent.
   */
  syntaxErrors: SyntaxDiagnostic[];
}

/** One parser diagnostic, with 1-based coordinates (line/column 0 = file-level failure). */
export interface SyntaxDiagnostic {
  message: string;
  line: number;
  column: number;
}

const TEST_FNS = new Set([
  "describe",
  "it",
  "test",
  "xit",
  "xdescribe",
  "xtest",
  "fit",
  "fdescribe",
]);
const SKIP_ONLY = new Set(["skip", "only"]);

/** A test file: `*.test.*` or `*.spec.*` in any JS/TS flavour. */
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;
export function isTestFilePath(filePath: string): boolean {
  return TEST_FILE_RE.test(filePath);
}

/** A TypeScript source file (the only kind the compiler API diagnostics below apply to). */
const TS_SOURCE_RE = /\.(ts|tsx|mts|cts)$/i;
export function isTypeScriptSourcePath(filePath: string): boolean {
  return TS_SOURCE_RE.test(filePath);
}

function scriptKindOf(fileName: string): ts.ScriptKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

interface ParsedSource {
  sourceFile: ts.SourceFile;
  diagnostics: SyntaxDiagnostic[];
}

/** A cheap JSX/TSX signal used only to decide whether a TSX re-parse is worth trying. */
const LOOKS_LIKE_JSX = /<[A-Za-z][\w.:-]*[\s/>]/;

function parseDiagnosticsOf(sourceFile: ts.SourceFile): SyntaxDiagnostic[] {
  // `parseDiagnostics` is on SourceFile at runtime but not part of the public type surface.
  const raw = (
    sourceFile as ts.SourceFile & {
      parseDiagnostics?: readonly ts.Diagnostic[];
    }
  ).parseDiagnostics;
  if (!raw?.length) return [];
  return raw.map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.file !== undefined && d.start !== undefined) {
      const pos = d.file.getLineAndCharacterOfPosition(d.start);
      return { message, line: pos.line + 1, column: pos.character + 1 };
    }
    return { message, line: 0, column: 0 };
  });
}

/**
 * Parse TypeScript (or TSX/JSX) without ever throwing. `.ts` files whose contents are actually
 * JSX are retried as TSX when that produces fewer diagnostics — editors and generators routinely
 * save TSX into the wrong extension, and the compiler API otherwise reports a wall of syntax
 * errors for otherwise-valid JSX.
 */
export function parseTypeScript(sourceText: string, fileName = "file.ts"): ParsedSource {
  const create = (name: string, kind: ts.ScriptKind): ts.SourceFile =>
    ts.createSourceFile(name, sourceText, ts.ScriptTarget.Latest, true, kind);
  let sourceFile = create(fileName, scriptKindOf(fileName));
  let diagnostics = parseDiagnosticsOf(sourceFile);
  if (diagnostics.length > 0 && !/\.[jt]sx$/i.test(fileName) && LOOKS_LIKE_JSX.test(sourceText)) {
    const tsxFile = create(`${fileName}.tsx`, ts.ScriptKind.TSX);
    const tsxDiagnostics = parseDiagnosticsOf(tsxFile);
    if (tsxDiagnostics.length < diagnostics.length) {
      sourceFile = tsxFile;
      diagnostics = tsxDiagnostics;
    }
  }
  return { sourceFile, diagnostics };
}

// ---------------------------------------------------------------------------
// Expected values (`expect(...).toBe/toEqual/toStrictEqual(<literal>)`)
// ---------------------------------------------------------------------------

export interface ExpectedAssertion {
  /** Title of the enclosing `it`/`test`, with enclosing `describe` titles joined by ` › `. */
  testTitle: string;
  matcher: "toBe" | "toEqual" | "toStrictEqual";
  /** Source text of the expected value (`toBe(5)` → `5`; `toBe(-1)` → `-1`). */
  expected: string;
  /** Source text of the value under test (`expect(add(2, 3))` → `add(2, 3)`). */
  actual: string;
  /** 1-based line of the matcher call in the source text. */
  line: number;
  /** True when the chain includes `.not` (`expect(x).not.toBe(y)`). */
  negated: boolean;
  /** `.resolves` / `.rejects` when present on the expect chain. */
  modifier?: "resolves" | "rejects";
}

const EXPECT_MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual"]);

/** Literal expected values only: a non-literal (`toBe(SOME_CONST)`) cannot be compared by text. */
function isLiteralExpected(node: ts.Node): boolean {
  if (ts.isArrayLiteralExpression(node)) return node.elements.every((element) => isLiteralExpected(element));
  if (ts.isObjectLiteralExpression(node)) {
    // Only plain `key: literal` entries are comparable; shorthand, methods and
    // spreads make the textual value unstable.
    return node.properties.every(
      (property) => ts.isPropertyAssignment(property) && isLiteralExpected(property.initializer),
    );
  }
  return (
    ts.isNumericLiteral(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isPrefixUnaryExpression(node) &&
      (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
      ts.isNumericLiteral(node.operand))
  );
}

interface ExpectChain {
  root?: ts.CallExpression;
  negated: boolean;
  modifier?: "resolves" | "rejects";
}

/**
 * The `expect(...)` call a matcher chain hangs off, plus the `.not` and
 * `.resolves` / `.rejects` modifiers in the chain. Walking the whole chain is
 * what lets the verifier notice `toBe(0)` -> `not.toBe(0)` as a changed
 * expectation rather than an identical one.
 */
function expectChain(node: ts.Node): ExpectChain {
  let negated = false;
  let modifier: "resolves" | "rejects" | undefined;
  let current: ts.Node = node;
  while (ts.isPropertyAccessExpression(current)) {
    const name = current.name.text;
    if (name === "not") negated = true;
    else if (name === "resolves" || name === "rejects") modifier = name;
    current = current.expression;
  }
  if (ts.isCallExpression(current)) {
    const callee = current.expression;
    if (ts.isIdentifier(callee) && callee.text === "expect") {
      return { root: current, negated, modifier };
    }
  }
  return { negated, modifier };
}

/** Split a call callee into its root identifier and the property chain below it. */
function calleeChain(callee: ts.Expression): { name: string; modifiers: string[] } | undefined {
  const modifiers: string[] = [];
  let current: ts.Expression = callee;
  while (ts.isPropertyAccessExpression(current)) {
    modifiers.unshift(current.name.text);
    current = current.expression;
  }
  return ts.isIdentifier(current) ? { name: current.text, modifiers } : undefined;
}

/**
 * Extract every `expect(<actual>).toBe/toEqual/toStrictEqual(<literal>)`
 * assertion, tagged with its enclosing test title. Pure — no filesystem
 * access. Used by the verification pipeline to tell a weakened expectation
 * (`toBe(5)` → `toBe(6)`) from an added one: changing an expected value
 * keeps the assertion count the same, so counting alone cannot see it.
 *
 * Known limits: non-literal expected values are skipped (not comparable by
 * text), and `it.each`/`test.each` titles are not resolved (the title is the
 * enclosing describe scope, or '' at top level).
 */
export function extractExpectations(sourceText: string, fileName = "file.ts"): ExpectedAssertion[] {
  try {
    const { sourceFile: sf } = parseTypeScript(sourceText, fileName);
    const out: ExpectedAssertion[] = [];

    const titleOf = (call: ts.CallExpression): string | undefined => {
      const first = call.arguments[0];
      return first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
        ? first.text
        : undefined;
    };

    const visit = (node: ts.Node, scope: string, testTitle: string): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const info = calleeChain(callee);
        const describeModifiers = info?.modifiers.every((m) => m === "skip" || m === "only") ?? false;
        // describe('...', fn) / describe.skip / describe.only: extend the scope.
        if (info && (info.name === "describe" || info.name === "xdescribe") && describeModifiers) {
          const title = titleOf(node);
          const nextScope = title === undefined ? scope : scope ? `${scope} › ${title}` : title;
          node.forEachChild((child) => {
            visit(child, nextScope, testTitle);
          });
          return;
        }
        // it('...', fn) / test.only / test.skip / test.todo: the callback's
        // assertions belong to this title.
        if (
          info &&
          (info.name === "it" ||
            info.name === "test" ||
            info.name === "xit" ||
            info.name === "fit" ||
            info.name === "xtest")
        ) {
          const title = titleOf(node);
          const full = title === undefined ? testTitle : scope ? `${scope} › ${title}` : title;
          node.forEachChild((child) => {
            visit(child, scope, full);
          });
          return;
        }
        // expect(<actual>).toBe/toEqual/toStrictEqual(<literal>)
        if (ts.isPropertyAccessExpression(callee) && EXPECT_MATCHERS.has(callee.name.text)) {
          const chain = expectChain(callee.expression);
          const expectedArg = node.arguments[0];
          if (chain.root && chain.root.arguments.length > 0 && expectedArg && isLiteralExpected(expectedArg)) {
            out.push({
              testTitle,
              matcher: callee.name.text as ExpectedAssertion["matcher"],
              expected: expectedArg.getText(sf),
              actual: (chain.root.arguments[0] as ts.Node).getText(sf),
              line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
              negated: chain.negated,
              ...(chain.modifier ? { modifier: chain.modifier } : {}),
            });
          }
        }
      }
      node.forEachChild((child) => {
        visit(child, scope, testTitle);
      });
    };
    visit(sf, "", "");
    return out;
  } catch {
    // A parser/runtime failure must not escape into the verification pipeline; a missing
    // assertion list is reported by the (separate) syntax/parse diagnostics check instead.
    return [];
  }
}

function isDecision(node: ts.Node): boolean {
  if (
    ts.isIfStatement(node) ||
    ts.isConditionalExpression(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCaseClause(node) ||
    ts.isCatchClause(node)
  ) {
    return true;
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    return (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
      op === ts.SyntaxKind.BarBarEqualsToken ||
      op === ts.SyntaxKind.QuestionQuestionEqualsToken
    );
  }
  return false;
}

/** Analyse one source text. Pure — no filesystem access, and never throws. */
export function analyzeSourceText(sourceText: string, fileName = "file.ts"): SourceAnalysis {
  try {
    const { sourceFile: sf, diagnostics } = parseTypeScript(sourceText, fileName);
    let assertionCount = 0;
    let hasSkipOrOnly = false;
    let maxComplexity = 0;
    const relativeImports: string[] = [];

    const isTestCall = (node: ts.CallExpression): boolean => {
      const callee = node.expression;
      // A bare `expect(x)` has no matcher and is not an assertion; a bare
      // `assert(x)` (node:assert callable form) is.
      if (ts.isIdentifier(callee)) return callee.text === "assert";
      // Walk the whole property chain so `assert.strict.equal(...)` and
      // `expect(x).not.toBe(...)` both count.
      let current: ts.Node = callee;
      while (ts.isPropertyAccessExpression(current)) current = current.expression;
      if (ts.isCallExpression(current)) {
        // A matcher chain roots at the `expect(...)` call itself.
        const root = current.expression;
        return ts.isIdentifier(root) && root.text === "expect";
      }
      if (ts.isIdentifier(current)) return current.text === "assert";
      return false;
    };

    const isFunctionLike = (node: ts.Node): boolean =>
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isClassStaticBlockDeclaration(node);

    // Cyclomatic complexity, scored per function (nested functions get their own
    // budget) plus one unit for top-level code.
    const scoreFunction = (fn: ts.Node): void => {
      let decisions = 0;
      const walk = (node: ts.Node): void => {
        if (isFunctionLike(node)) {
          scoreFunction(node);
          return;
        }
        if (isDecision(node)) decisions++;
        ts.forEachChild(node, walk);
      };
      ts.forEachChild(fn, walk);
      maxComplexity = Math.max(maxComplexity, 1 + decisions);
    };
    let topLevelDecisions = 0;
    const walkTopLevel = (node: ts.Node): void => {
      if (isFunctionLike(node)) {
        scoreFunction(node);
        return;
      }
      if (isDecision(node)) topLevelDecisions++;
      ts.forEachChild(node, walkTopLevel);
    };
    ts.forEachChild(sf, walkTopLevel);
    maxComplexity = Math.max(maxComplexity, 1 + topLevelDecisions);

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        if (spec.startsWith(".")) relativeImports.push(spec);
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        // `export { x } from "./x"` / `export * from "./x"` is an edge too.
        const spec = node.moduleSpecifier.text;
        if (spec.startsWith(".")) relativeImports.push(spec);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        // `await import("./x")` is a real dependency edge.
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg) && arg.text.startsWith(".")) relativeImports.push(arg.text);
      }
      if (ts.isCallExpression(node)) {
        if (isTestCall(node)) assertionCount++;
        const callee = node.expression;
        if (ts.isPropertyAccessExpression(callee)) {
          // Walk the chain so test.skip.each / test.only.each and it.todo are
          // caught, not only one-level test.skip.
          let current: ts.Expression = callee;
          let marker = false;
          while (ts.isPropertyAccessExpression(current)) {
            const name = current.name.text;
            if (SKIP_ONLY.has(name) || name === "todo") marker = true;
            current = current.expression;
          }
          if (marker && ts.isIdentifier(current) && TEST_FNS.has(current.text)) hasSkipOrOnly = true;
        }
        if (
          ts.isIdentifier(callee) &&
          (callee.text === "xit" ||
            callee.text === "xdescribe" ||
            callee.text === "xtest" ||
            callee.text === "fit" ||
            callee.text === "fdescribe")
        ) {
          hasSkipOrOnly = true;
        }
        // node:test option object: test('x', { skip: true }, fn) / { only: true }.
        if (ts.isIdentifier(callee) && TEST_FNS.has(callee.text)) {
          for (const arg of node.arguments) {
            if (!ts.isObjectLiteralExpression(arg)) continue;
            for (const property of arg.properties) {
              if (!ts.isPropertyAssignment(property)) continue;
              const key = ts.isIdentifier(property.name)
                ? property.name.text
                : ts.isStringLiteral(property.name)
                  ? property.name.text
                  : "";
              if (
                (key === "skip" || key === "only" || key === "todo") &&
                property.initializer.kind === ts.SyntaxKind.TrueKeyword
              ) {
                hasSkipOrOnly = true;
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    return {
      assertionCount,
      hasSkipOrOnly,
      maxCyclomaticComplexity: maxComplexity,
      relativeImports,
      syntaxErrors: diagnostics,
    };
  } catch (err) {
    return {
      assertionCount: 0,
      hasSkipOrOnly: false,
      maxCyclomaticComplexity: 0,
      relativeImports: [],
      syntaxErrors: [
        {
          message: `TypeScript analysis failed: ${err instanceof Error ? err.message : String(err)}`,
          line: 0,
          column: 0,
        },
      ],
    };
  }
}

/** Analyse one file from disk. Returns zeros (and a diagnostic) when the file cannot be read. */
export function analyzeFile(filePath: string): SourceAnalysis {
  try {
    return analyzeSourceText(readFileSync(filePath, "utf8"), filePath);
  } catch (err) {
    return {
      assertionCount: 0,
      hasSkipOrOnly: false,
      maxCyclomaticComplexity: 0,
      relativeImports: [],
      syntaxErrors: [
        {
          message: `cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
          line: 0,
          column: 0,
        },
      ],
    };
  }
}

/** Total expect/assert calls across the given files. */
export function countAssertionsInFiles(filePaths: readonly string[]): number {
  return filePaths.reduce((sum, p) => sum + analyzeFile(p).assertionCount, 0);
}

/** Highest per-function cyclomatic complexity across the given files. */
export function maxComplexityInFiles(filePaths: readonly string[]): number {
  return filePaths.reduce((max, p) => Math.max(max, analyzeFile(p).maxCyclomaticComplexity), 0);
}

/** Relative import specifiers of one file (for the flake detector's import graph). */
export function collectRelativeImports(filePath: string): string[] {
  return analyzeFile(filePath).relativeImports;
}
