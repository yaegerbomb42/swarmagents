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
  /** Set when the patch creates or modifies this path as a symlink (mode 120000). */
  symlink?: boolean;
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

/** Index of the closing quote at or after `start`, honoring backslash escapes; -1 when unterminated. */
function closingQuote(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === '"') return i;
    i++;
  }
  return -1;
}

/**
 * Split a `diff --git <a> <b>` header into its two raw path tokens.
 *
 * Handles git's C-style quoted paths (including escaped quotes inside them)
 * and unquoted paths containing spaces (split at the last ` b/` boundary,
 * since the a-side always starts with `a/`).
 */
function splitDiffGit(line: string): [string, string] | null {
  const rest = line.slice("diff --git ".length).trim();
  if (!rest) return null;
  if (rest.startsWith('"')) {
    const end = closingQuote(rest, 0);
    if (end === -1) return null;
    const first = rest.slice(0, end + 1);
    const second = rest.slice(end + 1).trim();
    if (!second) return null;
    if (second.startsWith('"')) {
      const end2 = closingQuote(second, 0);
      if (end2 === -1) return null;
      return [first, second.slice(0, end2 + 1)];
    }
    return [first, second];
  }
  if (rest.startsWith("a/")) {
    const boundary = rest.lastIndexOf(" b/");
    if (boundary > 0) return [rest.slice(0, boundary), rest.slice(boundary + 1)];
  }
  const space = rest.indexOf(" ");
  if (space === -1) return null;
  return [rest.slice(0, space), rest.slice(space + 1).trim()];
}

/**
 * Parse the files a unified diff touches. Understands `git diff` headers
 * (new/deleted/rename/copy) and plain `---`/`+++` diffs. Order is first-seen.
 *
 * Every path a section declares is captured — the `diff --git` a-side, the
 * `---`/`+++` headers, and `rename`/`copy from`/`to` — so a crafted patch
 * cannot hide an escaping path behind a benign git header.
 */
export function parsePatchFiles(diff: string): PatchFile[] {
  const files: PatchFile[] = [];
  const add = (file: PatchFile) => {
    if (file.path && !files.some((f) => f.path === file.path)) files.push(file);
  };
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  let current: PatchFile | null = null;
  /** The a-side of the current section's git header (validated at flush time). */
  let gitAside: string | null = null;
  /** Inside a git file section, ---/+++ only count before the first hunk. */
  let inHunk = false;

  /** Close the current section, keeping any a-side path it declared. */
  const flushCurrent = () => {
    if (!current) return;
    if (gitAside !== null && gitAside !== current.path && gitAside !== current.oldPath) {
      add({ path: gitAside, status: "M" });
    }
    add(current);
    current = null;
    gitAside = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      const git = splitDiffGit(line);
      if (git) {
        flushCurrent();
        const a = stripPrefix(git[0]);
        const b = stripPrefix(git[1]);
        gitAside = a;
        current = { path: b ?? a ?? "", status: "M" };
        inHunk = false;
        continue;
      }
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (current && !inHunk) {
      if (line.startsWith("new file mode")) {
        current.status = "A";
        if (/^new file mode 120000$/.test(line)) current.symlink = true;
      } else if (line.startsWith("deleted file mode")) {
        current.status = "D";
      } else if (line.startsWith("old mode ")) {
        if (/^old mode 120000$/.test(line)) current.symlink = true;
      } else if (line.startsWith("new mode ")) {
        if (/^new mode 120000$/.test(line)) current.symlink = true;
      } else if (line.startsWith("rename from ")) {
        current.status = "R";
        current.oldPath = unquote(line.slice("rename from ".length));
      } else if (line.startsWith("rename to ")) {
        const target = unquote(line.slice("rename to ".length));
        if (target !== current.path) {
          // The git header named a different path: keep it as its own entry
          // so it is still validated, then record the rename target.
          add({ path: current.path, status: current.status, ...(current.oldPath ? { oldPath: current.oldPath } : {}) });
          current.path = target;
        }
      } else if (line.startsWith("copy from ")) {
        current.oldPath = unquote(line.slice("copy from ".length));
      } else if (line.startsWith("copy to ")) {
        const target = unquote(line.slice("copy to ".length));
        if (target !== current.path) {
          add({ path: current.path, status: current.status, ...(current.oldPath ? { oldPath: current.oldPath } : {}) });
          current.path = target;
        }
        current.status = "A";
      } else if (line.startsWith("+++ ")) {
        const next = stripPrefix(line.slice(4));
        if (next === null) current.status = "D";
        else if (next !== current.path) add({ path: next, status: current.status });
      } else if (line.startsWith("--- ")) {
        const prev = stripPrefix(line.slice(4));
        if (prev === null && current.status === "M") current.status = "A";
        else if (prev !== null && prev !== current.path && prev !== current.oldPath) {
          add({ path: prev, status: current.status });
        }
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
  flushCurrent();
  return files;
}

/**
 * Paths a patch must never touch: absolute, escaping the repo, inside
 * .git (any segment, case-insensitively), containing NUL/control
 * characters, or created/modified as a symlink. Returns the offending
 * paths (empty when the patch is safe).
 */
export function unsafePatchPaths(files: PatchFile[]): string[] {
  const bad: string[] = [];
  const push = (p: string) => {
    if (!bad.includes(p)) bad.push(p);
  };
  for (const file of files) {
    // A patch that creates or modifies a path as a symlink is unsafe even
    // when the path itself looks innocent.
    if (file.symlink) push(file.path || "(empty path)");
    for (const p of [file.path, file.oldPath]) {
      if (p === undefined) continue;
      const parts = p.replace(/\\/g, "/").split("/");
      if (
        !p ||
        /[\0-\x1F\x7F]/.test(p) ||
        p.startsWith("/") ||
        /^[A-Za-z]:/.test(p) ||
        parts.includes("..") ||
        parts.some((part) => part.toLowerCase() === ".git")
      ) {
        push(p || "(empty path)");
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
