/**
 * CODE MUTATOR — Safe file system operations for autonomous improvement.
 *
 * This is part of the IMMUTABLE CORE. It enforces safety boundaries:
 *   - Can only modify files in the mutable layer
 *   - Cannot touch core files, node_modules, .git, etc.
 *   - Always creates backups before modifying
 *   - Validates changes (syntax, build) before committing
 */

import fs from 'fs/promises';
import path from 'path';

const PROJECT_ROOT = process.cwd();
const BACKUP_DIR = path.join(PROJECT_ROOT, '.swarmagents-backups');

const IMMUTABLE_PATTERNS = [
  /src\/lib\/core\//,
  /src\/lib\/engine-service\.ts/,
  /node_modules/,
  /\.git\//,
  /\.next\//,
  /\.swarmagents/,
  /package-lock\.json/,
  /\.env/,
];

export interface MutationResult {
  ok: boolean;
  filePath: string;
  backupPath?: string;
  error?: string;
  diff?: string;
}

export interface MutationPlan {
  filePath: string;
  oldContent?: string; // If provided, verify match before replacing
  newContent: string;
  reason: string;
}

// ─── Safety Checks ──────────────────────────────────────────
export function isMutable(filePath: string): boolean {
  const normalized = path.normalize(filePath);
  // Must be within project root
  if (!normalized.startsWith(PROJECT_ROOT) && !normalized.startsWith('src/') && !normalized.startsWith('public/')) {
    return false;
  }
  // Must not match immutable patterns
  for (const pattern of IMMUTABLE_PATTERNS) {
    if (pattern.test(normalized)) return false;
  }
  return true;
}

export function resolveProjectPath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.join(PROJECT_ROOT, filePath);
}

// ─── Read Operations ────────────────────────────────────────
export async function readFile(filePath: string): Promise<string> {
  const fullPath = resolveProjectPath(filePath);
  if (!isMutable(fullPath)) throw new Error(`IMMUTABLE: ${filePath} cannot be read by mutator`);
  return fs.readFile(fullPath, 'utf-8');
}

export async function listDirectory(dirPath: string): Promise<string[]> {
  const fullPath = resolveProjectPath(dirPath);
  const entries = await fs.readdir(fullPath, { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && isMutable(path.join(fullPath, e.name)))
    .map(e => e.name);
}

// ─── Write Operations ───────────────────────────────────────
export async function applyMutation(plan: MutationPlan): Promise<MutationResult> {
  const fullPath = resolveProjectPath(plan.filePath);

  if (!isMutable(fullPath)) {
    return { ok: false, filePath: plan.filePath, error: `File is immutable: ${plan.filePath}` };
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(fullPath);
  await fs.mkdir(parentDir, { recursive: true });

  // Read current content for backup and diff
  let currentContent = '';
  let backupPath: string | undefined;
  try {
    currentContent = await fs.readFile(fullPath, 'utf-8');
    // Create backup
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    const timestamp = Date.now();
    const backupName = `${path.basename(plan.filePath)}.${timestamp}.bak`;
    backupPath = path.join(BACKUP_DIR, backupName);
    await fs.writeFile(backupPath, currentContent);
  } catch {
    // File doesn't exist yet — new file
  }

  // Verify oldContent matches if provided
  if (plan.oldContent !== undefined && plan.oldContent !== currentContent) {
    return {
      ok: false,
      filePath: plan.filePath,
      backupPath,
      error: 'Content mismatch — file changed since plan was created',
      diff: computeDiff(currentContent, plan.oldContent).slice(0, 500),
    };
  }

  // Apply change
  try {
    await fs.writeFile(fullPath, plan.newContent, 'utf-8');
    const diff = computeDiff(currentContent, plan.newContent);
    return { ok: true, filePath: plan.filePath, backupPath, diff: diff.slice(0, 1000) };
  } catch (e: any) {
    return { ok: false, filePath: plan.filePath, backupPath, error: String(e?.message ?? e) };
  }
}

export async function restoreFromBackup(filePath: string, timestamp?: number): Promise<MutationResult> {
  const fullPath = resolveProjectPath(filePath);
  if (!isMutable(fullPath)) {
    return { ok: false, filePath, error: `File is immutable: ${filePath}` };
  }

  const backups = await fs.readdir(BACKUP_DIR);
  const fileBackups = backups.filter(b => b.startsWith(path.basename(filePath)));
  if (fileBackups.length === 0) {
    return { ok: false, filePath, error: 'No backups found' };
  }

  // Sort by timestamp descending, pick most recent (or specific timestamp)
  fileBackups.sort((a, b) => {
    const tsA = parseInt(a.match(/\.(\d+)\.bak$/)?.[1] ?? '0');
    const tsB = parseInt(b.match(/\.(\d+)\.bak$/)?.[1] ?? '0');
    return tsB - tsA;
  });

  const backupToUse = timestamp
    ? fileBackups.find(b => b.includes(String(timestamp)))
    : fileBackups[0];

  if (!backupToUse) {
    return { ok: false, filePath, error: 'Specified backup not found' };
  }

  const backupContent = await fs.readFile(path.join(BACKUP_DIR, backupToUse), 'utf-8');
  await fs.writeFile(fullPath, backupContent);
  return { ok: true, filePath, backupPath: path.join(BACKUP_DIR, backupToUse) };
}

// ─── Validation ─────────────────────────────────────────────
export async function validateBuild(): Promise<{ ok: boolean; output: string }> {
  const { execSync } = await import('child_process');
  try {
    const output = execSync('npm run build 2>&1', { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 120000 });
    return { ok: true, output: output.slice(-2000) };
  } catch (e: any) {
    const output = e.stdout || e.message || String(e);
    return { ok: false, output: output.slice(-2000) };
  }
}

export async function runTests(): Promise<{ ok: boolean; output: string }> {
  const { execSync } = await import('child_process');
  try {
    const output = execSync('npm test 2>&1', { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 120000 });
    return { ok: true, output: output.slice(-2000) };
  } catch (e: any) {
    const output = e.stdout || e.message || String(e);
    return { ok: false, output: output.slice(-2000) };
  }
}

// ─── Diff Utility ───────────────────────────────────────────
function computeDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const diff: string[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxLen; i++) {
    if (oldLines[i] !== newLines[i]) {
      if (oldLines[i] !== undefined) diff.push(`- ${oldLines[i]}`);
      if (newLines[i] !== undefined) diff.push(`+ ${newLines[i]}`);
    }
  }

  return diff.join('\n');
}
