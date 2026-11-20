/**
 * Unified-diff helpers for the oracle gate: which files a candidate patch
 * touches, and whether any of those paths is unsafe to apply.
 */

export type PatchFileStatus = "A" | "M" | "D" | "R";

export interface PatchFile {
  /** Repo-relative path after the patch (the old path for deletions). */
  path: string;
  status: PatchFileStatus;
  /** Set for renames. */
  oldPath?: string;
}

/** Undo git's C-style quoting of paths with special characters. */
function unquote(raw: string): string {
  const value = raw.trim();
  if (!(value.startsWith('"') && value.endsWith('"'))) return value;
  return value
    .slice(1, -1)
    .replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\(.)/g, (_, ch: string) => ({ n: "\n", t: "\t" })[ch as "n" | "t"] ?? ch);
}

function stripPrefix(raw: string): string | null {
  const value = unquote(raw.split("\t")[0]);
  if (value === "/dev/null") return null;
  return value.replace(/^[ab]\//, "");
}

/**
 * Parse the files a unified diff touches. Understands `git diff` headers
 * (new/deleted/rename) and plain `---`/`+++` diffs. Order is first-seen.
 */
export function parsePatchFiles(diff: string): PatchFile[] {
  const files: PatchFile[] = [];
  const add = (file: PatchFile) => {
    if (file.path && !files.some((f) => f.path === file.path)) files.push(file);
  };
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  let current: PatchFile | null = null;
  /** Inside a git file section, ---/+++ only count before the first hunk. */
  let inHunk = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const git = /^diff --git (".*?"|\S+) (".*?"|\S+)$/.exec(line);
    if (git) {
      if (current) add(current);
      const a = stripPrefix(git[1]);
      const b = stripPrefix(git[2]);
      current = { path: b ?? a ?? "", status: "M" };
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (current && !inHunk) {
      if (line.startsWith("new file mode")) current.status = "A";
      else if (line.startsWith("deleted file mode")) current.status = "D";
      else if (line.startsWith("rename from ")) {
        current.status = "R";
        current.oldPath = unquote(line.slice("rename from ".length));
      } else if (line.startsWith("rename to ")) current.path = unquote(line.slice("rename to ".length));
      else if (line.startsWith("+++ ")) {
        const next = stripPrefix(line.slice(4));
        if (next === null) current.status = "D";
      } else if (line.startsWith("--- ") && stripPrefix(line.slice(4)) === null && current.status === "M") {
        current.status = "A";
      }
      continue;
    }
    // Plain unified diff (no git header): a "--- " line directly followed by "+++ ".
    if (!current && line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      const oldSide = stripPrefix(line.slice(4));
      const newSide = stripPrefix(lines[i + 1].slice(4));
      add({
        path: newSide ?? oldSide ?? "",
        status: newSide === null ? "D" : oldSide === null ? "A" : "M",
      });
      i++;
      inHunk = false;
    }
  }
  if (current) add(current);
  return files;
}

/**
 * Paths a patch must never touch: absolute, escaping the repo, or inside
 * .git. Returns the offending paths (empty when the patch is safe).
 */
export function unsafePatchPaths(files: PatchFile[]): string[] {
  const bad: string[] = [];
  for (const file of files) {
    for (const p of [file.path, file.oldPath]) {
      if (p === undefined) continue;
      const parts = p.replace(/\\/g, "/").split("/");
      if (!p || p.startsWith("/") || /^[A-Za-z]:/.test(p) || parts.includes("..") || parts[0] === ".git") {
        bad.push(p || "(empty path)");
      }
    }
  }
  return bad;
}

/** Added + removed lines: the tie-breaker between passing candidates. */
export function countChurn(diff: string): number {
  let n = 0;
  for (const line of diff.split("\n")) {
    if ((line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))) n++;
  }
  return n;
}
