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

function parseIstanbulJsonSummary(jsonText: string): CoverageReport | null {
  try {
    const data = JSON.parse(jsonText) as Record<string, any>;
    const total = data.total?.lines;
    const files: CoverageFile[] = [];
    const uncoveredRanges: string[] = [];
    for (const [file, v] of Object.entries(data)) {
      if (file === "total") continue;
      const lines = v?.lines;
      const ranges: string[] = [];
      // istanbul json-summary doesn't carry ranges; keep uncovered empty, we can fill from text if present
      const entry: CoverageFile = { path: file, linesPct: pct(lines?.pct), uncovered: ranges };
      files.push(entry);
    }
    return {
      framework: "istanbul/c8",
      linesPct: pct(total?.pct),
      files,
      uncoveredRanges,
      raw: jsonText.slice(0, 4000),
    };
  } catch {
    return null;
  }
}

function parseGoCoverProfile(text: string): CoverageReport | null {
  // mode: atomic/set/count
  if (!/^mode:\s*\w+/m.test(text)) return null;
  const fileStats = new Map<string, { covered: number; total: number; uncovered: string[] }>();
  for (const line of text.split("\n")) {
    const m = line.match(/^(.+):(\d+)\.\d+,(\d+)\.\d+\s+\d+\s+(\d+)$/);
    if (!m) continue;
    const [, file, startStr, endStr, countStr] = m;
    const start = Number(startStr), end = Number(endStr), count = Number(countStr);
    const s = fileStats.get(file) ?? { covered: 0, total: 0, uncovered: [] };
    const span = Math.max(1, end - start + 1);
    s.total += span;
    if (count > 0) s.covered += span;
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
  // pytest-cov / coverage.py term-missing table:
  // Name                      Stmts   Miss  Cover   Missing
  // -------------------------------------------------------
  // mypkg/mod.py                 10      2    80%   5-6
  // -------------------------------------------------------
  // TOTAL                        10      2    80%
  if (!/Name\s+Stmts\s+Miss\s+Cover/i.test(text) || !/TOTAL/i.test(text)) return null;
  const files: CoverageFile[] = [];
  const uncoveredRanges: string[] = [];
  let totalPct: number | undefined;
  for (const line of text.split("\n")) {
    const m = line.match(/^(\S.*?)\s+(\d+)\s+(\d+)\s+(\d+)%\s*(.*)$/);
    if (!m) continue;
    const [, name, , , cover, missing] = m;
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
  const jsonMatch = out.match(/\{[\s\S]*"total"\s*:\s*\{[\s\S]*"lines"[\s\S]*\}/);
  if (jsonMatch) {
    const parsed = parseIstanbulJsonSummary(jsonMatch[0]);
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
