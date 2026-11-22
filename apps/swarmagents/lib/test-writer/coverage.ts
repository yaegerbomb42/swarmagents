export interface CoverageFile {
  path: string;
  linesPct?: number;
  uncovered?: string[]; // ranges like "10-12", "45"
}

export interface CoverageReport {
  framework: string;
  linesPct?: number;
  files: CoverageFile[];
  uncoveredRanges: string[];
  raw?: string;
}

function pct(n: unknown): number | undefined {
  const v = typeof n === "string" ? Number(n.replace("%", "")) : typeof n === "number" ? n : NaN;
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : undefined;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIstanbulJsonSummary(jsonText: string): CoverageReport | null {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }
  // A summary must be a non-null plain object containing a total object
  // with lines: "null", "[]", "{}" or any other JSON shape is not a
  // summary and must not produce a vacuous report (the old code returned
  // one for "[]" and "{}", since Object.entries over them is empty).
  if (!isJsonObject(data)) return null;
  const total = data.total;
  if (!isJsonObject(total)) return null;
  const totalLines = total.lines;
  if (!isJsonObject(totalLines)) return null;
  const files: CoverageFile[] = [];
  const uncoveredRanges: string[] = [];
  for (const [file, v] of Object.entries(data)) {
    if (file === "total") continue;
    const lines = isJsonObject(v) ? v.lines : undefined;
    const ranges: string[] = [];
    // istanbul json-summary doesn't carry ranges; keep uncovered empty, we can fill from text if present
    const entry: CoverageFile = {
      path: file,
      linesPct: pct(isJsonObject(lines) ? lines.pct : undefined),
      uncovered: ranges,
    };
    files.push(entry);
  }
  return {
    framework: "istanbul/c8",
    linesPct: pct(totalLines.pct),
    files,
    uncoveredRanges,
    raw: jsonText.slice(0, 4000),
  };
}

function parseGoCoverProfile(text: string): CoverageReport | null {
  // mode: atomic/set/count
  if (!/^mode:\s*\w+/m.test(text)) return null;
  const fileStats = new Map<string, { covered: number; total: number; uncovered: string[] }>();
  for (const line of text.split("\n")) {
    // file:startLine.startCol,endLine.endCol numStmt count
    const m = line.match(/^(.+):(\d+)\.\d+,(\d+)\.\d+\s+(\d+)\s+(\d+)$/);
    if (!m) continue;
    const [, file, startStr, endStr, numStmtStr, countStr] = m;
    const start = Number(startStr), end = Number(endStr), count = Number(countStr);
    // Weight by numStmt (the statement count), not by the line span:
    // blocks sharing a line would otherwise double-count it, and a long
    // block with one statement would count as many lines.
    const weight = Number(numStmtStr);
    const s = fileStats.get(file) ?? { covered: 0, total: 0, uncovered: [] };
    s.total += weight;
    if (count > 0) s.covered += weight;
    else s.uncovered.push(start === end ? String(start) : `${start}-${end}`);
    fileStats.set(file, s);
  }
  if (fileStats.size === 0) return null;
  const files: CoverageFile[] = [];
  let covered = 0, total = 0;
  const uncoveredRanges: string[] = [];
  for (const [file, s] of fileStats) {
    covered += s.covered; total += s.total;
    files.push({ path: file, linesPct: s.total ? (s.covered / s.total) * 100 : undefined, uncovered: s.uncovered.slice(0, 20) });
    for (const r of s.uncovered.slice(0, 10)) uncoveredRanges.push(`${file}:${r}`);
  }
  return {
    framework: "go-cover",
    linesPct: total ? (covered / total) * 100 : undefined,
    files,
    uncoveredRanges: uncoveredRanges.slice(0, 50),
    raw: text.slice(0, 4000),
  };
}

function parsePytestCovText(text: string): CoverageReport | null {
  // pytest-cov / coverage.py term-missing table, classic and --cov-branch:
  // Name                      Stmts   Miss  Cover   Missing
  // -------------------------------------------------------
  // mypkg/mod.py                 10      2    80%   5-6
  // -------------------------------------------------------
  // TOTAL                        10      2    80%
  //
  // --cov-branch adds Branch/BrPart columns between Miss and Cover, and
  // Cover may be fractional (89.5%).
  // Name                      Stmts   Miss  Branch BrPart  Cover   Missing
  // -----------------------------------------------------------------------
  // mypkg/mod.py                 10      2       4      1    80%   5-6
  // TOTAL                        10      2       4      1    80%
  if (!/Name\s+Stmts\s+Miss\s+(Branch\s+BrPart\s+)?Cover/i.test(text) || !/TOTAL/i.test(text)) return null;
  const files: CoverageFile[] = [];
  const uncoveredRanges: string[] = [];
  let totalPct: number | undefined;
  for (const line of text.split("\n")) {
    const m = line.match(/^(\S.*?)\s+(\d+)\s+(\d+)\s+(?:(\d+)\s+(\d+)\s+)?(\d+(?:\.\d+)?)%\s*(.*)$/);
    if (!m) continue;
    const [, name, , , , , cover, missing] = m;
    if (/^TOTAL$/i.test(name.trim())) {
      totalPct = pct(cover);
      continue;
    }
    if (/^-{3,}$/.test(name.trim())) continue;
    const ranges = (missing || "").trim() ? (missing || "").trim().split(/,\s*/).filter(Boolean) : [];
    files.push({ path: name.trim(), linesPct: pct(cover), uncovered: ranges });
    for (const r of ranges.slice(0, 10)) uncoveredRanges.push(`${name.trim()}:${r}`);
  }
  if (files.length === 0 && totalPct === undefined) return null;
  return { framework: "pytest-cov", linesPct: totalPct, files, uncoveredRanges: uncoveredRanges.slice(0, 50), raw: text.slice(0, 4000) };
}

function parseGenericCoverageText(text: string): CoverageReport | null {
  // Vitest/jest/c8 text summaries often include "All files ... | xx.xx |"
  // or "Lines ...: xx.xx%"
  const lines: string[] = text.split("\n");
  let totalPct: number | undefined;
  for (const line of lines) {
    const all = line.match(/All files\s*\|\s*([\d.]+)/i) || line.match(/Lines\s*[:|]\s*([\d.]+)%?/i) || line.match(/Statements\s*[:|]\s*([\d.]+)%?/i);
    if (all && totalPct === undefined) totalPct = pct(all[1]);
  }
  if (totalPct === undefined) return null;
  return { framework: "text", linesPct: totalPct, files: [], uncoveredRanges: [], raw: text.slice(0, 4000) };
}

/**
 * Bounds for the inline-JSON extractor below. A coverage summary embedded
 * in test output is at most a few hundred KB; the caps keep a hostile or
 * huge log from turning extraction into a hang.
 */
const MAX_INLINE_JSON_BYTES = 1024 * 1024;
const MAX_INLINE_JSON_SCAN = 2 * 1024 * 1024;
const MAX_INLINE_JSON_CANDIDATES = 100;

function looksLikeIstanbulSummary(candidate: string): boolean {
  try {
    const data = JSON.parse(candidate) as unknown;
    if (!isJsonObject(data)) return false;
    const total = data.total;
    if (!isJsonObject(total)) return false;
    return isJsonObject(total.lines);
  } catch {
    return false;
  }
}

/**
 * Find the first balanced `{...}` JSON object in log output that parses as
 * an istanbul summary (top-level `total` object with `lines`).
 *
 * This replaces the old `/\{[\s\S]*"total"\s*:\s*\{[\s\S]*"lines"[\s\S]*\}/`
 * match, which had two defects: its three greedy `[\s\S]*` runs backtrack
 * catastrophically on a large log without a match (ReDoS — the engine tries
 * every split of the input between the stars), and on a match it spanned
 * from the first `{` to the last `}` across unrelated output. Brace counting
 * (skipping string contents, with escape handling) finds the true end of
 * each candidate, and the scan budget plus the candidate cap bound the total
 * work no matter what the log contains.
 */
function extractIstanbulJson(text: string): string | null {
  let remaining = MAX_INLINE_JSON_SCAN;
  let candidates = 0;
  let start = 0;
  while (start < text.length && remaining > 0 && candidates < MAX_INLINE_JSON_CANDIDATES) {
    const open = text.indexOf("{", start);
    if (open === -1) return null;
    candidates++;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let close = -1;
    const limit = Math.min(text.length, open + MAX_INLINE_JSON_BYTES);
    for (let i = open; i < limit && remaining > 0; i++, remaining--) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close !== -1) {
      const candidate = text.slice(open, close + 1);
      if (looksLikeIstanbulSummary(candidate)) return candidate;
    }
    // No balanced close in range, or not a summary: try the next "{".
    start = open + 1;
  }
  return null;
}

export function parseCoverageOutput(opts: { stdout?: string; stderr?: string; files?: Record<string, string> }): CoverageReport | null {
  const out = `${opts.stdout ?? ""}\n${opts.stderr ?? ""}`;
  const files = opts.files ?? {};
  // Prefer structured files
  for (const [name, content] of Object.entries(files)) {
    if (/coverage-summary\.json$/i.test(name) || /coverage\.json$/i.test(name)) {
      const parsed = parseIstanbulJsonSummary(content);
      if (parsed) return parsed;
    }
    if (/coverage\.out$/i.test(name) || /coverprofile/i.test(name)) {
      const parsed = parseGoCoverProfile(content);
      if (parsed) return parsed;
    }
  }
  // Try inline JSON
  const inlineJson = extractIstanbulJson(out);
  if (inlineJson) {
    const parsed = parseIstanbulJsonSummary(inlineJson);
    if (parsed) return parsed;
  }
  const go = parseGoCoverProfile(out);
  if (go) return go;
  const py = parsePytestCovText(out);
  if (py) return py;
  const generic = parseGenericCoverageText(out);
  if (generic) return generic;
  return null;
}

export function formatCoverageSummary(r: CoverageReport): string {
  const pctStr = r.linesPct != null ? `${r.linesPct.toFixed(1)}%` : "n/a";
  const files = r.files.length;
  const uncovered = r.uncoveredRanges.length;
  return `lines ${pctStr}, files ${files}, uncovered ranges ${uncovered}`;
}
