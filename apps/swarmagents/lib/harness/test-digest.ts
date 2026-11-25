/**
 * Compact failing-test digest and runner summary extractor.
 *
 * Ported from vendor/omnexx/src/tools/{test-digest.ts,output-summary.ts} and
 * `relevantLines` in vendor/omnexx/src/verify/triage.ts, reusing
 * lib/verification/parsers.ts for JSON/structured test formats.
 */

import { parseGoTest, parseJestLike, parsePytest } from "../verification/parsers";

const MAX_DIGEST_CHARS = 1500;
const PARSE_CTX = { gate: "bash", exitCode: 1, cwd: "" };

const ESC = String.fromCodePoint(0x1b);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");

interface SummaryCounts {
  passed?: number | undefined;
  failed?: number | undefined;
  skipped?: number | undefined;
}

const numFrom = (m: RegExpExecArray | null, i = 1): number | undefined =>
  m?.[i] === undefined ? undefined : Number(m[i]);

const SUMMARY_RUNNERS: ((text: string) => SummaryCounts | undefined)[] = [
  // vitest: "Tests  40 passed | 2 failed (42)"
  (t) => {
    const line = /^\s*Tests\s{2,}(.+)$/m.exec(t)?.[1];
    if (!line) return undefined;
    return {
      passed: numFrom(/(\d+) passed/.exec(line)),
      failed: numFrom(/(\d+) failed/.exec(line)),
      skipped: numFrom(/(\d+) skipped/.exec(line)),
    };
  },
  // jest: "Tests:       2 failed, 40 passed, 42 total"
  (t) => {
    const line = /^Tests:\s+(.+)$/m.exec(t)?.[1];
    if (!line) return undefined;
    return {
      passed: numFrom(/(\d+) passed/.exec(line)),
      failed: numFrom(/(\d+) failed/.exec(line)),
      skipped: numFrom(/(\d+) skipped/.exec(line)),
    };
  },
  // pytest: "==== 2 failed, 42 passed, 1 skipped in 1.23s ===="
  (t) => {
    const line = /^=+ (.+ in [\d.]+s.*) =+$/m.exec(t)?.[1];
    if (!line) return undefined;
    return {
      passed: numFrom(/(\d+) passed/.exec(line)),
      failed: numFrom(/(\d+) failed/.exec(line)),
      skipped: numFrom(/(\d+) skipped/.exec(line)),
    };
  },
  // node:test (TAP): "# pass 40" / "# fail 2"
  (t) => {
    const pass = numFrom(/^# pass (\d+)$/m.exec(t));
    if (pass === undefined) return undefined;
    return { passed: pass, failed: numFrom(/^# fail (\d+)$/m.exec(t)) };
  },
  // mocha: "40 passing (2s)" / "2 failing"
  (t) => {
    const pass = numFrom(/^\s*(\d+) passing\b/m.exec(t));
    if (pass === undefined) return undefined;
    return { passed: pass, failed: numFrom(/^\s*(\d+) failing\b/m.exec(t)) };
  },
  // cargo: "test result: FAILED. 40 passed; 2 failed; 0 ignored"
  (t) => {
    const line = /^test result: \w+\. (.+)$/m.exec(t)?.[1];
    if (!line) return undefined;
    return {
      passed: numFrom(/(\d+) passed/.exec(line)),
      failed: numFrom(/(\d+) failed/.exec(line)),
    };
  },
];

/** Extract a compact one-line summary (`"40 passed, 2 failed"`) from test runner output. */
export function extractTestSummary(output: string): string | undefined {
  let found: SummaryCounts | undefined;
  for (const runner of SUMMARY_RUNNERS) found = runner(output) ?? found;
  if (!found || (found.passed === undefined && found.failed === undefined)) return undefined;
  const parts = [
    found.passed !== undefined ? `${String(found.passed)} passed` : "",
    found.failed ? `${String(found.failed)} failed` : "",
    found.skipped ? `${String(found.skipped)} skipped` : "",
  ].filter(Boolean);
  return parts.join(", ");
}

const DEP_FRAME = /node_modules|site-packages|node:internal|<anonymous>|\(internal\//;
const TRIAGE_STACK_FRAME = /^\s*(at |File "|\S+\.\w+:\d+)/;

/** Keep the first 3 assertion lines and first 3 non-dependency stack frames. */
export function relevantLines(message: string): string[] {
  const lines = message.split("\n").filter((l) => l.trim());
  const head = lines.filter((l) => !TRIAGE_STACK_FRAME.test(l)).slice(0, 3);
  const frames = lines
    .filter((l) => TRIAGE_STACK_FRAME.test(l) && !DEP_FRAME.test(l))
    .slice(0, 3);
  return [...head, ...frames].slice(0, 6).map((l) => l.trimEnd().slice(0, 200));
}

const ENV = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*`;
const BIN = String.raw`(?:npx\s+|bunx\s+|pnpm\s+(?:exec\s+)?|yarn(?:\s+dlx)?\s+)?(?:\S*/)?`;
const VITEST = new RegExp(String.raw`^${ENV}${BIN}vitest(?:\.m?js)?(?:\s|$)`);
const JEST = new RegExp(String.raw`^${ENV}${BIN}jest(?:\.m?js)?(?:\s|$)`);
const PYTEST = new RegExp(
  String.raw`^${ENV}(?:(?:uv\s+run|poetry\s+run|pipenv\s+run)\s+)?(?:python3?\s+-m\s+)?(?:\S*/)?pytest(?:\s|$)`,
);
const GO_TEST = new RegExp(String.raw`^${ENV}go\s+test(?:\s|$)`);
const CARGO_TEST = new RegExp(String.raw`^${ENV}cargo\s+test(?:\s|$)`);
const NPM_TEST =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:npm\s+t|(?:(?:npm|pnpm|yarn)(?:\s+run)?|bun(?:\s+run)?)\s+test(?:[:.-][\w.-]+)?)(?:\s|$)/;

/** `&&`, pipes, and `;` hide which command failed; redirections (`2>&1`) stay one command. */
const COMPOUND = /&&|\|\||[;\n]|`|\$\(|(?:^|[^>])\||(?:^|[^>&])&(?!&)/;

const FRAME_LINE = /^\s*(?:at |File "|\S+\.\w+:\d+)/;
const PROJECT_LOC = /((?:[\w.@+-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs):\d+(?::\d+)?)/;
const RUNNER_PATH =
  /node_modules|site-packages|node:internal|\(internal\/|[/\\]_pytest[/\\]|[/\\]pluggy[/\\]|[/\\]rustc[/\\]|[/\\]library[/\\](?:core|std|alloc)[/\\]|[/\\]src[/\\]testing[/\\]testing\.go\b/;
const ASSERT_LINE =
  /AssertionError|\bError:|\bassert(?:ion)?\b|Expected:|Received:|\bleft:|\bright:|\bgot\b|\bwant\b|\bpanic(?:ked)?\b/i;
const DROP_LINE =
  /^(?:\s*(?:----+.*----|failures:|note: run with\b.*|running \d+ tests|=== RUN\b.*|--- (?:FAIL|PASS|SKIP):.*|thread '.*' panicked at .*|test \S+ \.\.\. (?:ok|FAILED)|[⎯─=]{3,}.*)\s*)$/;

type Kind = "vitest" | "jest" | "pytest" | "go" | "cargo" | "script";

interface DigestFailure {
  name: string;
  assertion: string;
  frame?: string | undefined;
}

function unquoted(command: string): string {
  return command.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '""');
}

function testCommandKind(command: string): Kind | undefined {
  const flat = command.trim().replace(/[ \t]+/g, " ");
  if (!flat || COMPOUND.test(unquoted(flat))) return undefined;
  if (VITEST.test(flat)) return "vitest";
  if (JEST.test(flat)) return "jest";
  if (PYTEST.test(flat)) return "pytest";
  if (GO_TEST.test(flat)) return "go";
  if (CARGO_TEST.test(flat)) return "cargo";
  if (NPM_TEST.test(flat)) return "script";
  return undefined;
}

function clipText(text: string, max = 300): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function normalizeBlock(block: string): string {
  return block
    .split("\n")
    .map((l) => l.replace(/^(\s*)❯\s+/, "$1at "))
    .filter((l) => !RUNNER_PATH.test(l))
    .join("\n");
}

function projectFrame(text: string): string | undefined {
  for (const line of text.split("\n")) {
    if (RUNNER_PATH.test(line)) continue;
    const loc = PROJECT_LOC.exec(line)?.[1];
    if (loc && !RUNNER_PATH.test(loc)) return loc;
  }
  return undefined;
}

function messageAfterLocation(text: string, frame: string | undefined): string {
  if (!frame) return "";
  for (const line of text.split("\n")) {
    const idx = line.indexOf(frame);
    if (idx < 0) continue;
    const rest = line
      .slice(idx + frame.length)
      .replace(/^[\s:.-]+/, "")
      .trim();
    if (rest) return rest;
  }
  return "";
}

function parts(block: string): { assertion: string; frame?: string } {
  const text = normalizeBlock(block);
  const frame = projectFrame(text);
  const kept = relevantLines(
    text
      .split("\n")
      .filter((l) => !DROP_LINE.test(l))
      .join("\n"),
  ).filter((l) => !FRAME_LINE.test(l));
  const interesting = kept.filter((l) => ASSERT_LINE.test(l));
  const chosen = (interesting.length > 0 ? interesting : kept).slice(0, 4).join("\n");
  const assertion = clipText(chosen || messageAfterLocation(text, frame));
  return { assertion: assertion || "failed", ...(frame ? { frame } : {}) };
}

function between(lines: readonly string[], start: number, stop: (line: string) => boolean): string {
  const body: string[] = [];
  for (let j = start; j < lines.length; j++) {
    const line = lines[j] ?? "";
    if (stop(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

function jestJson(output: string): DigestFailure[] | undefined {
  if (!output.includes('"testResults"')) return undefined;
  const parsed = parseJestLike(output, PARSE_CTX);
  if (!parsed.structured || parsed.failures.length === 0) return undefined;
  return parsed.failures.map((f) => ({ name: f.id, ...parts(f.message) }));
}

function parseVitestDigest(output: string): DigestFailure[] | undefined {
  const fromJson = jestJson(output);
  if (fromJson) return fromJson;
  if (!/^ FAIL\s+/m.test(output) || !/(^ ❯ |^ Test Files |^⎯)/m.test(output)) return undefined;
  const lines = output.split("\n");
  const out: DigestFailure[] = [];
  for (let i = 0; i < lines.length; i++) {
    const name = /^ FAIL\s+(?:\|[^|]*\|\s+)?(\S.*?)\s*$/.exec(lines[i] ?? "")?.[1];
    if (!name) continue;
    const body = between(
      lines,
      i + 1,
      (l) =>
        l.startsWith(" FAIL") ||
        l.startsWith("⎯") ||
        l.startsWith(" Test Files ") ||
        /^\s+Tests\s{2}/.test(l),
    );
    out.push({ name: clipText(name, 180), ...parts(body) });
  }
  return out.length > 0 ? out : undefined;
}

function parseJestDigest(output: string): DigestFailure[] | undefined {
  const fromJson = jestJson(output);
  if (fromJson) return fromJson;
  if (!/^ FAIL\s+\S/m.test(output) || !output.includes("●")) return undefined;
  const lines = output.split("\n");
  const out: DigestFailure[] = [];
  let file = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const failFile = /^ FAIL\s+(\S+)/.exec(line)?.[1];
    if (failFile) file = failFile;
    const title = /^\s+●\s+(.+?)\s*$/.exec(line)?.[1];
    if (!title) continue;
    const body = between(
      lines,
      i + 1,
      (l) =>
        /^\s+●\s+/.test(l) ||
        l.startsWith(" FAIL") ||
        l.startsWith("Test Suites:") ||
        l.startsWith("Tests:"),
    );
    const name = file ? `${file} > ${title}` : title;
    out.push({ name: clipText(name, 180), ...parts(body) });
  }
  return out.length > 0 ? out : undefined;
}

function pytestSection(output: string, id: string): string | undefined {
  const name = id.split("::").at(-1);
  if (!name) return undefined;
  const header = new RegExp(`^_+\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+_+$`);
  const lines = output.split("\n");
  const start = lines.findIndex((l) => header.test(l));
  if (start < 0) return undefined;
  return between(lines, start + 1, (l) => /^_+\s+\S/.test(l) || /^=+/.test(l));
}

function parsePytestDigest(output: string): DigestFailure[] | undefined {
  const parsed = parsePytest(output, PARSE_CTX);
  if (!parsed.structured || parsed.failures.length === 0) return undefined;
  return parsed.failures.map((f) => {
    const section = pytestSection(output, f.id);
    const fromSection = section ? parts(section) : undefined;
    const fromMessage = parts(f.message);
    const assertion =
      fromSection && fromSection.assertion !== "failed"
        ? fromSection.assertion
        : fromMessage.assertion;
    const frame = fromSection?.frame ?? fromMessage.frame;
    return { name: f.id, assertion, ...(frame ? { frame } : {}) };
  });
}

function parseGoDigest(output: string): DigestFailure[] | undefined {
  if (output.includes('"Action"') && /^\{/m.test(output)) {
    const parsed = parseGoTest(output, PARSE_CTX);
    if (parsed.structured && parsed.failures.length > 0) {
      return parsed.failures.map((f) => ({ name: f.id, ...parts(f.message) }));
    }
  }
  const lines = output.split("\n");
  const out: DigestFailure[] = [];
  for (let i = 0; i < lines.length; i++) {
    const name = /^[ \t]*--- FAIL: (\S+)/.exec(lines[i] ?? "")?.[1];
    if (!name) continue;
    const body = between(
      lines,
      i + 1,
      (l) => /^[ \t]*--- (?:FAIL|PASS|SKIP):/.test(l) || /^(?:=== RUN|FAIL|ok)\b/.test(l),
    );
    const failure = parts(body);
    if (failure.assertion === "failed" && !failure.frame) continue;
    out.push({ name, ...failure });
  }
  return out.length > 0 ? out : undefined;
}

function parseCargoDigest(output: string): DigestFailure[] | undefined {
  if (!/^---- .+ stdout ----$/m.test(output) && !/^test result: FAILED/m.test(output)) {
    return undefined;
  }
  const lines = output.split("\n");
  const out: DigestFailure[] = [];
  for (let i = 0; i < lines.length; i++) {
    const name = /^---- (.+) stdout ----$/.exec(lines[i] ?? "")?.[1];
    if (!name) continue;
    const body = between(
      lines,
      i + 1,
      (l) => /^---- .+ stdout ----$/.test(l) || /^failures:\s*$/.test(l),
    );
    out.push({ name, ...parts(body) });
  }
  return out.length > 0 ? out : undefined;
}

const DIGEST_PARSERS: Record<Exclude<Kind, "script">, (output: string) => DigestFailure[] | undefined> = {
  vitest: parseVitestDigest,
  jest: parseJestDigest,
  pytest: parsePytestDigest,
  go: parseGoDigest,
  cargo: parseCargoDigest,
};

function extractDigestFailures(kind: Kind, output: string): DigestFailure[] | undefined {
  if (kind !== "script") return DIGEST_PARSERS[kind](output);
  for (const parse of Object.values(DIGEST_PARSERS)) {
    const found = parse(output);
    if (found && found.length > 0) return found;
  }
  return undefined;
}

function countsLabel(output: string, failed: number): string {
  const summary = extractTestSummary(output);
  if (summary) return summary;
  const passed =
    output.match(/^[ \t]*--- PASS:/gm)?.length ??
    output.match(/^test \S+ \.\.\. ok$/gm)?.length ??
    0;
  return `${passed} passed, ${failed} failed`;
}

interface DedupedFailure extends DigestFailure {
  count: number;
}

function deduplicateFailures(failures: readonly DigestFailure[]): DedupedFailure[] {
  const map = new Map<string, DedupedFailure>();
  for (const f of failures) {
    const key = `${f.name}::${f.assertion}::${f.frame ?? ""}`;
    const existing = map.get(key);
    if (existing) existing.count++;
    else map.set(key, { ...f, count: 1 });
  }
  return [...map.values()];
}

function formatDigestFailure(f: DedupedFailure): string {
  const countTag = f.count > 1 ? ` (repeats ${String(f.count)}x)` : "";
  const assertion = f.assertion.replace(/\n/g, "\n  ");
  return [`- ${f.name}${countTag}`, `  ${assertion}`, ...(f.frame ? [`  ${f.frame}`] : [])].join(
    "\n",
  );
}

function joinDigest(header: string, kept: readonly string[], omitted: number): string {
  const note = omitted > 0 ? `… ${omitted} more failures omitted` : "";
  return [header, ...kept, note].filter((p) => p.length > 0).join("\n");
}

function renderDigest(summary: string, logRef: string | undefined, rawFailures: readonly DigestFailure[]): string {
  const header = logRef ? `tests: ${summary}\nlog: ${logRef}` : `tests: ${summary}`;
  const failures = deduplicateFailures(rawFailures);
  const blocks = failures.map(formatDigestFailure);
  const kept: string[] = [];
  for (const block of blocks) {
    const omittedAfter = blocks.length - (kept.length + 1);
    if (joinDigest(header, [...kept, block], omittedAfter).length <= MAX_DIGEST_CHARS) {
      kept.push(block);
      continue;
    }
    if (kept.length === 0) {
      const note = blocks.length > 1 ? `\n… ${blocks.length - 1} more failures omitted` : "";
      const room = MAX_DIGEST_CHARS - header.length - note.length - 1;
      kept.push(block.slice(0, Math.max(1, room)));
    }
    break;
  }
  const text = joinDigest(header, kept, blocks.length - kept.length);
  if (text.length <= MAX_DIGEST_CHARS) return text;
  const cut = text.slice(0, MAX_DIGEST_CHARS - 1);
  return `${cut}…`;
}

/**
 * Produce a compact failing-test digest (<= 1500 chars) when `command` is a
 * single test run and the output contains recognizable runner failures;
 * returns undefined otherwise.
 */
export function testDigest(command: string, output: string, logRef?: string): string | undefined {
  const kind = testCommandKind(command);
  if (!kind) return undefined;
  const text = output.replace(ANSI_RE, "").replace(/\r/g, "");
  const failures = extractDigestFailures(kind, text);
  if (!failures || failures.length === 0) return undefined;
  return renderDigest(countsLabel(text, failures.length), logRef, failures);
}
