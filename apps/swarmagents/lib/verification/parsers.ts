/**
 * Structured output parsers for test runners and compiler/lint gates.
 *
 * Ported from vendor/omnexx/src/verify/parsers/{types.ts,index.ts} with zero
 * host-fs or execa dependencies so every parser runs purely on captured stdout.
 */

export type GateParser =
  | "vitest"
  | "jest"
  | "node-test"
  | "tsc"
  | "eslint"
  | "pytest"
  | "gotest"
  | "cargo"
  | "generic";

export interface Failure {
  /** Stable identity used by ratchets and triage: test path, `file:TS1234:msg`, `file:rule`, ... */
  id: string;
  location?: string;
  /** Capped excerpt (<= 20 lines) surfaced to the agent or telemetry. */
  message: string;
}

export interface TestCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface ParsedOutput {
  failures: Failure[];
  tests?: TestCounts;
  /** False when the output wasn't in the expected format and the generic fallback was used. */
  structured: boolean;
}

export interface ParseContext {
  gate: string;
  exitCode: number;
  /** Worktree root stripped from locations so failure IDs survive moved checkouts. */
  cwd: string;
}

export const MAX_MESSAGE_LINES = 20;

export function clipFailureMessage(message: string, lines = MAX_MESSAGE_LINES): string {
  const all = message.replace(/\r/g, "").split("\n");
  const kept = all.slice(0, lines);
  return (all.length > lines ? [...kept, `… (${all.length - lines} more lines)`] : kept)
    .join("\n")
    .trimEnd();
}

/** Make an absolute path relative to the worktree, tolerating macOS `/private` and `file://` prefixes. */
export function relPath(filePath: string, cwd: string): string {
  let p = filePath.replace(/^file:\/\//, "");
  if (!cwd) return p;
  for (const root of [cwd, `/private${cwd}`, cwd.replace(/^\/private/, "")]) {
    if (root && p.startsWith(`${root}/`)) {
      p = p.slice(root.length + 1);
      break;
    }
  }
  return p;
}

/** Find the first valid JSON object/array in noisy output (e.g. `npm run` banners). */
export function extractJson(output: string, opener: "{" | "["): unknown {
  const closer = opener === "{" ? "}" : "]";
  const end = output.lastIndexOf(closer);
  if (end < 0) return undefined;
  for (let i = output.indexOf(opener); i >= 0 && i < end; i = output.indexOf(opener, i + 1)) {
    try {
      return JSON.parse(output.slice(i, end + 1)) as unknown;
    } catch {
      // Keep scanning in case an earlier banner contained the opener char.
    }
  }
  return undefined;
}

const ERROR_LINE = /\b(error|fail(ed|ure)?|exception|panic|traceback|assert)/i;
const STACK_NOISE = /^\s+at .*(node_modules|node:internal)/;

function cleanStack(msg: string): string {
  return msg
    .split("\n")
    .filter((l) => !STACK_NOISE.test(l))
    .join("\n");
}

/** Exit code plus the most error-looking lines. Used when no structured parser matches. */
export function parseGeneric(output: string, ctx: ParseContext): ParsedOutput {
  if (ctx.exitCode === 0) return { failures: [], structured: false };
  const lines = output.split("\n");
  const interesting = lines.filter((l) => ERROR_LINE.test(l));
  const message = clipFailureMessage((interesting.length ? interesting : lines.slice(-20)).join("\n"));
  return {
    failures: [{ id: `${ctx.gate}:exit`, message: message || `exit code ${ctx.exitCode}` }],
    structured: false,
  };
}

interface JestLikeReport {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  testResults?: {
    name?: string;
    message?: string;
    status?: string;
    assertionResults?: {
      fullName?: string;
      title?: string;
      ancestorTitles?: string[];
      status?: string;
      failureMessages?: string[];
      location?: { line?: number } | null;
    }[];
  }[];
}

/** `vitest --reporter=json` and `jest --json` share this report shape. */
export function parseJestLike(output: string, ctx: ParseContext): ParsedOutput {
  const data = extractJson(output, "{") as JestLikeReport | undefined;
  if (!data || !Array.isArray(data.testResults)) return parseGeneric(output, ctx);
  const failures: Failure[] = [];
  for (const file of data.testResults) {
    const rel = relPath(file.name ?? "", ctx.cwd);
    const asserts = file.assertionResults ?? [];
    for (const a of asserts) {
      if (a.status !== "failed") continue;
      const name = a.fullName ?? [...(a.ancestorTitles ?? []), a.title ?? ""].join(" ");
      const rawMsg = cleanStack((a.failureMessages ?? []).join("\n"));
      failures.push({
        id: `${rel} > ${name}`,
        location: a.location?.line ? `${rel}:${a.location.line}` : rel,
        message: clipFailureMessage(ctx.cwd ? rawMsg.split(ctx.cwd).join(".") : rawMsg),
      });
    }
    if (file.status === "failed" && !asserts.some((a) => a.status === "failed")) {
      failures.push({
        id: `${rel} > (file failed to run)`,
        location: rel,
        message: clipFailureMessage(cleanStack(file.message ?? "")),
      });
    }
  }
  const total = data.numTotalTests ?? 0;
  return {
    failures,
    tests: {
      total,
      passed: data.numPassedTests ?? 0,
      failed: data.numFailedTests ?? 0,
      skipped: (data.numPendingTests ?? 0) + (data.numTodoTests ?? 0),
    },
    structured: true,
  };
}

/** `node --test --test-reporter=tap`: nested subtests; only leaf test failures count. */
export function parseNodeTap(output: string, ctx: ParseContext): ParsedOutput {
  if (!/^TAP version/m.test(output)) return parseGeneric(output, ctx);
  const lines = output.split("\n");
  const failures: Failure[] = [];
  const names: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const sub = /^(\s*)# Subtest: (.*)$/.exec(line);
    if (sub) {
      const depth = (sub[1] ?? "").length / 4;
      names.length = depth;
      names[depth] = sub[2] ?? "";
      continue;
    }
    const nok = /^(\s*)not ok \d+ - (.*?)(\s+#.*)?$/.exec(line);
    if (!nok) continue;
    const depth = (nok[1] ?? "").length / 4;
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] ?? "";
      if (/^\s*\.\.\.\s*$/.test(l)) break;
      block.push(l);
    }
    const yaml = block.join("\n");
    if (yaml.includes("failureType: 'subtestsFailed'")) continue;
    const loc = /location: '([^']+)'/.exec(yaml)?.[1];
    const rel = loc ? relPath(loc, ctx.cwd) : undefined;
    const file = rel?.replace(/:\d+:\d+$/, "") ?? "";
    const testPath = [...names.slice(0, depth), nok[2] ?? ""].join(" > ");
    const errMatch =
      /error: \|-\n([\s\S]*?)\n\s+(code|name|expected|stack|failureType):/.exec(yaml) ??
      /error: '([^']*)'/.exec(yaml);
    const msg = (errMatch?.[1] ?? "test failed")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n");
    failures.push({
      id: `${file} > ${testPath}`,
      ...(rel ? { location: rel } : {}),
      message: clipFailureMessage(msg),
    });
  }
  const n = (k: string): number => Number(new RegExp(`^# ${k} (\\d+)`, "m").exec(output)?.[1] ?? 0);
  return {
    failures,
    tests: {
      total: n("tests"),
      passed: n("pass"),
      failed: n("fail") + n("cancelled"),
      skipped: n("skipped") + n("todo"),
    },
    structured: true,
  };
}

/** `tsc` diagnostics: `file(line,col): error TS1234: message`. */
export function parseTsc(output: string, ctx: ParseContext): ParsedOutput {
  const failures: Failure[] = [];
  const re = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/gm;
  for (const m of output.matchAll(re)) {
    const file = relPath(m[1] ?? "", ctx.cwd);
    failures.push({
      id: `${file}:${m[4] ?? ""}:${m[5] ?? ""}`,
      location: `${file}:${m[2] ?? ""}:${m[3] ?? ""}`,
      message: `${m[4] ?? ""}: ${m[5] ?? ""}`,
    });
  }
  if (!failures.length && ctx.exitCode !== 0) return parseGeneric(output, ctx);
  return { failures, structured: true };
}

interface EslintFile {
  filePath?: string;
  messages?: {
    ruleId?: string | null;
    severity?: number;
    message?: string;
    line?: number;
    column?: number;
  }[];
}

/** `eslint -f json`, falling back to stylish text format (severity 2 errors only). */
export function parseEslint(output: string, ctx: ParseContext): ParsedOutput {
  const data = extractJson(output, "[") as EslintFile[] | undefined;
  const failures: Failure[] = [];
  if (Array.isArray(data)) {
    for (const f of data) {
      const file = relPath(f.filePath ?? "", ctx.cwd);
      for (const m of f.messages ?? []) {
        if (m.severity !== 2) continue;
        const rule = m.ruleId ?? "fatal";
        failures.push({
          id: `${file}:${rule}`,
          location: `${file}:${m.line ?? 0}:${m.column ?? 0}`,
          message: `${rule}: ${m.message ?? ""}`,
        });
      }
    }
    return { failures, structured: true };
  }
  let file = "";
  for (const line of output.split("\n")) {
    if (/^\S.*\.[cm]?[jt]sx?$/.test(line.trim()) && !line.startsWith(" ")) {
      file = relPath(line.trim(), ctx.cwd);
    }
    const m = /^\s+(\d+):(\d+)\s+error\s+(.*?)\s{2,}(\S+)\s*$/.exec(line);
    if (m && file) {
      failures.push({
        id: `${file}:${m[4] ?? ""}`,
        location: `${file}:${m[1] ?? ""}:${m[2] ?? ""}`,
        message: `${m[4] ?? ""}: ${m[3] ?? ""}`,
      });
    }
  }
  if (!failures.length && ctx.exitCode !== 0) return parseGeneric(output, ctx);
  return { failures, structured: failures.length > 0 || ctx.exitCode === 0 };
}

/** `pytest` (`-rf` short summary): `FAILED path::test - message` lines + summary bar. */
export function parsePytest(output: string, ctx: ParseContext): ParsedOutput {
  const failures: Failure[] = [];
  for (const m of output.matchAll(/^(FAILED|ERROR) (\S+?)(?: - (.*))?$/gm)) {
    failures.push({
      id: m[2] ?? "",
      location: (m[2] ?? "").split("::")[0] ?? "",
      message: clipFailureMessage(m[3] ?? m[1] ?? "failed"),
    });
  }
  const summary = /^=+ (.*) in [\d.]+s.*=+$/m.exec(output)?.[1];
  if (!summary) return failures.length ? { failures, structured: true } : parseGeneric(output, ctx);
  const count = (k: string): number => Number(new RegExp(`(\\d+) ${k}`).exec(summary)?.[1] ?? 0);
  const failed = count("failed") + count("errors?");
  const passed = count("passed");
  const skipped = count("skipped") + count("xfailed");
  return {
    failures,
    tests: { total: failed + passed + skipped, passed, failed, skipped },
    structured: true,
  };
}

/** `go test -json`: newline-delimited JSON events per package+test. */
export function parseGoTest(output: string, ctx: ParseContext): ParsedOutput {
  const outputs = new Map<string, string[]>();
  const results = new Map<string, string>();
  let sawJson = false;
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    let ev: { Action?: string; Package?: string; Test?: string; Output?: string };
    try {
      ev = JSON.parse(line) as typeof ev;
    } catch {
      continue;
    }
    sawJson = true;
    if (!ev.Test) continue;
    const key = `${ev.Package ?? ""}.${ev.Test}`;
    if (ev.Action === "output" && ev.Output) {
      outputs.set(key, [...(outputs.get(key) ?? []), ev.Output.trim()]);
    }
    if (ev.Action === "pass" || ev.Action === "fail" || ev.Action === "skip") {
      results.set(key, ev.Action);
    }
  }
  if (!sawJson) return parseGeneric(output, ctx);
  const failures: Failure[] = [];
  let passed = 0;
  let skipped = 0;
  for (const [key, action] of results) {
    if (action === "pass") passed++;
    else if (action === "skip") skipped++;
    else {
      failures.push({
        id: key,
        message: clipFailureMessage(
          (outputs.get(key) ?? []).filter((l) => !/^(=== RUN|--- FAIL)/.test(l)).join("\n"),
        ),
      });
    }
  }
  return {
    failures,
    tests: { total: results.size, passed, failed: failures.length, skipped },
    structured: true,
  };
}

const CARGO_RESULT =
  /^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored(?:; (\d+) measured)?/;
const CARGO_FAILED = /^test (\S+) \.\.\. FAILED$/;
const CARGO_STDOUT = /^---- (\S+) stdout ----$/;

/** `cargo test` default libtest output. */
export function parseCargo(output: string, ctx: ParseContext): ParsedOutput {
  const lines = output.replace(/\r/g, "").split("\n");
  const counts = { passed: 0, failed: 0, skipped: 0 };
  let sawResult = false;
  const failed = new Set<string>();
  const stdout = new Map<string, string[]>();
  let block: string[] | undefined;
  for (const line of lines) {
    const result = CARGO_RESULT.exec(line);
    if (result) {
      sawResult = true;
      counts.passed += Number(result[1]);
      counts.failed += Number(result[2]);
      counts.skipped += Number(result[3]);
      block = undefined;
      continue;
    }
    const name = CARGO_FAILED.exec(line)?.[1];
    if (name) failed.add(name);
    const opened = CARGO_STDOUT.exec(line)?.[1];
    if (opened) {
      block = [];
      stdout.set(opened, block);
    } else if (/^failures:$/.test(line)) {
      block = undefined;
    } else {
      block?.push(line);
    }
  }
  if (!sawResult || (ctx.exitCode !== 0 && !failed.size)) return parseGeneric(output, ctx);
  const failures: Failure[] = [...failed].map((id) => ({
    id,
    message: clipFailureMessage((stdout.get(id) ?? []).join("\n").trim() || `${id} failed`),
  }));
  return {
    failures,
    tests: { total: counts.passed + counts.failed + counts.skipped, ...counts },
    structured: true,
  };
}

export function parseGateOutput(parser: GateParser, output: string, ctx: ParseContext): ParsedOutput {
  switch (parser) {
    case "vitest":
    case "jest":
      return parseJestLike(output, ctx);
    case "node-test":
      return parseNodeTap(output, ctx);
    case "tsc":
      return parseTsc(output, ctx);
    case "eslint":
      return parseEslint(output, ctx);
    case "pytest":
      return parsePytest(output, ctx);
    case "gotest":
      return parseGoTest(output, ctx);
    case "cargo":
      return parseCargo(output, ctx);
    case "generic":
      return parseGeneric(output, ctx);
  }
}
