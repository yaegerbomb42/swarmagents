import { git } from '../git/git.js';
import { isVendored } from '../agent/codemap.js';

/**
 * Patch diff extraction for SWE-bench submission format.
 *
 * Extracts a clean unified diff of the changes made to fix an issue,
 * filtering out vendored files and formatting for submission.
 */

export interface PatchDiff {
  files: string[];
  diff: string;
  stats: { additions: number; deletions: number };
}

/**
 * Extract the patch diff between two commits (or HEAD~1 and HEAD).
 */
export async function extractPatchDiff(
  root: string,
  contextLines = 3,
  fromRef = 'HEAD~1',
  toRef = 'HEAD',
): Promise<PatchDiff> {
  // If comparing against HEAD or working tree, ensure untracked files are visible to git diff
  try {
    await git(root, ['add', '-N', '.']);
  } catch {
    // Ignore when not in a valid git repository or add fails
  }

  const args = ['diff', '--binary', `--unified=${contextLines}`, '--no-color'];

  if (toRef === 'HEAD' || !toRef) {
    args.push(fromRef);
  } else {
    args.push(fromRef, toRef);
  }

  const diffOut = await git(root, args);

  if (diffOut.exitCode !== 0 || !diffOut.stdout.trim()) {
    return { files: [], diff: '', stats: { additions: 0, deletions: 0 } };
  }

  const rawDiff = diffOut.stdout;
  let filteredDiff = filterVendoredFiles(rawDiff);
  if (filteredDiff && !filteredDiff.endsWith('\n')) {
    filteredDiff += '\n';
  }
  const files = extractChangedFiles(filteredDiff);
  const stats = computeDiffStats(filteredDiff);

  return { files, diff: filteredDiff, stats };
}

/**
 * Filter out sections for vendored files from a diff.
 */
function filterVendoredFiles(diff: string): string {
  const sections = diff.split(/^(?=diff --git )/m);
  const filtered = sections.filter((section) => {
    const pathMatch = /^diff --git a\/(\S+)/.exec(section);
    const path = pathMatch?.[1];
    return !path || !isVendored(path);
  });
  return filtered.join('');
}

/**
 * Extract the list of changed files from a diff.
 */
function extractChangedFiles(diff: string): string[] {
  const files: string[] = [];
  const lines = diff.split('\n');

  for (const line of lines) {
    const match = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (match) {
      files.push(match[2] ?? match[1] ?? '');
    }
  }

  return [...new Set(files.filter(Boolean))];
}

/**
 * Compute addition/deletion stats from a diff.
 */
function computeDiffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  const lines = diff.split('\n');
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
    }
  }

  return { additions, deletions };
}

export interface SubmissionFormatOptions {
  /** If true, preserves a/ and b/ prefixes for git apply -p1 compatibility */
  preservePrefixes?: boolean;
}

/**
 * Format a diff for SWE-bench submission.
 * Strips index lines and optionally normalizes paths.
 */
export function formatForSubmission(diff: string, options: SubmissionFormatOptions = {}): string {
  const lines = diff.split('\n');
  const output: string[] = [];
  let inHeader = false;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      inHeader = true;
      continue;
    }
    if (line.startsWith('index ') && inHeader) {
      continue;
    }
    if (line.startsWith('---')) {
      inHeader = false;
      if (options.preservePrefixes) {
        const path = line.slice(4).trim();
        const normalized =
          path === '/dev/null' || path.startsWith('a/') ? path : `a/${path.replace(/^b\//, '')}`;
        output.push(`--- ${normalized}`);
      } else {
        const path = line.slice(4).replace(/^a\/|^b\//, '');
        output.push(`${line.slice(0, 3)} ${path}`);
      }
      continue;
    }
    if (line.startsWith('+++')) {
      inHeader = false;
      if (options.preservePrefixes) {
        const path = line.slice(4).trim();
        const normalized =
          path === '/dev/null' || path.startsWith('b/') ? path : `b/${path.replace(/^a\//, '')}`;
        output.push(`+++ ${normalized}`);
      } else {
        const path = line.slice(4).replace(/^a\/|^b\//, '');
        output.push(`${line.slice(0, 3)} ${path}`);
      }
      continue;
    }
    output.push(line);
  }

  return output.join('\n').trim();
}

/**
 * Ensures a patch string contains standard git unified diff headers with standard
 * `a/` and `b/` prefixes compatible with `git apply -p1` across modified, new,
 * and deleted files.
 */
export function ensureGitApplyPatch(diff: string): string {
  if (!diff.trim()) return '';
  const sections = diff.split(/^(?=diff --git |--- )/m).filter(Boolean);
  const formattedSections: string[] = [];

  for (const section of sections) {
    const lines = section.split('\n');
    let filePath = '';
    let hasGitHeader = false;

    // Scan for path
    for (const line of lines) {
      if (line.startsWith('diff --git ')) {
        hasGitHeader = true;
        const match = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
        if (match?.[2]) filePath = match[2];
        break;
      }
      if (line.startsWith('+++ ') && !filePath) {
        const candidate = line.slice(4).trim();
        if (candidate !== '/dev/null') filePath = candidate.replace(/^b\//, '');
      }
      if (line.startsWith('--- ') && !filePath) {
        const candidate = line.slice(4).trim();
        if (candidate !== '/dev/null') filePath = candidate.replace(/^a\//, '');
      }
    }

    const processedLines: string[] = [];
    if (!hasGitHeader && filePath) {
      processedLines.push(`diff --git a/${filePath} b/${filePath}`);
    }

    for (const line of lines) {
      if (line.startsWith('--- ')) {
        const raw = line.slice(4).trim();
        if (raw === '/dev/null') {
          processedLines.push('--- /dev/null');
        } else {
          const clean = raw.replace(/^[ab]\//, '');
          processedLines.push(`--- a/${clean}`);
        }
      } else if (line.startsWith('+++ ')) {
        const raw = line.slice(4).trim();
        if (raw === '/dev/null') {
          processedLines.push('+++ /dev/null');
        } else {
          const clean = raw.replace(/^[ab]\//, '');
          processedLines.push(`+++ b/${clean}`);
        }
      } else {
        processedLines.push(line);
      }
    }
    formattedSections.push(processedLines.join('\n'));
  }

  let result = formattedSections.join('\n');
  if (!result.endsWith('\n')) result += '\n';
  return result;
}

/**
 * Get the diff against the base commit (before any edits in this session).
 */
export async function getDiffFromBase(
  root: string,
  baseCommit: string,
  contextLines = 3,
): Promise<PatchDiff> {
  return extractPatchDiff(root, contextLines, baseCommit, 'HEAD');
}

/**
 * Check if the diff is empty (no actual changes).
 */
export function isDiffEmpty(patch: PatchDiff): boolean {
  return patch.files.length === 0 && patch.stats.additions === 0 && patch.stats.deletions === 0;
}

/**
 * Summarize the patch for logging/display.
 */
export function summarizePatch(patch: PatchDiff): string {
  if (isDiffEmpty(patch)) return 'No changes';

  const fileList = patch.files.slice(0, 5).join(', ');
  const more = patch.files.length > 5 ? ` (+${patch.files.length - 5} more)` : '';

  return `${patch.files.length} files changed: ${fileList}${more} (+${patch.stats.additions}/-${patch.stats.deletions})`;
}
