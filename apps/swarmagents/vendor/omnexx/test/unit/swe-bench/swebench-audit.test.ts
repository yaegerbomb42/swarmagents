import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git } from '../../../src/git/git.js';
import {
  ensureGitApplyPatch,
  extractPatchDiff,
  formatForSubmission,
} from '../../../src/swe-bench/patch-diff.js';
import { runReproTest, type ReproTest } from '../../../src/swe-bench/reproduce.js';

describe('Subsystem 6 Audit: SWE-bench Benchmark Extraction & Patch Engine', () => {
  let tempRepo: string;

  beforeEach(async () => {
    const raw = await mkdtemp(join(tmpdir(), 'omnexx-swebench-audit-'));
    tempRepo = realpathSync.native(raw);

    // Initialize git repo
    await git(tempRepo, ['init', '-b', 'main']);
    await git(tempRepo, ['config', 'user.name', 'Audit Tester']);
    await git(tempRepo, ['config', 'user.email', 'audit@example.com']);

    // Create initial commit
    await writeFile(join(tempRepo, 'initial.txt'), 'version 1\n', 'utf8');
    await git(tempRepo, ['add', 'initial.txt']);
    await git(tempRepo, ['commit', '-m', 'Initial commit']);
  });

  afterEach(async () => {
    await rm(tempRepo, { recursive: true, force: true }).catch(() => undefined);
  });

  describe('1. Patch Prefix Compatibility & git apply -p1', () => {
    it('generates standard a/ and b/ prefixes compatible with git apply -p1 for modifications', async () => {
      // Modify existing file
      await writeFile(join(tempRepo, 'initial.txt'), 'version 2 with fix\n', 'utf8');

      const patch = await extractPatchDiff(tempRepo, 3, 'HEAD');
      expect(patch.files).toContain('initial.txt');
      expect(patch.diff).toContain('diff --git a/initial.txt b/initial.txt');
      expect(patch.diff).toContain('--- a/initial.txt');
      expect(patch.diff).toContain('+++ b/initial.txt');

      // Verify git apply -p1 --check succeeds
      const patchPath = join(tempRepo, 'test.patch');
      await writeFile(patchPath, patch.diff, 'utf8');

      // Revert the working tree file to verify the patch applies cleanly
      await git(tempRepo, ['checkout', '--', 'initial.txt']);

      // Apply patch with git apply -p1
      const applyResult = await git(tempRepo, ['apply', '-p1', '--check', patchPath]);
      expect(applyResult.exitCode).toBe(0);
    });

    it('generates standard /dev/null and b/ prefixes for brand new files', async () => {
      // Create new file
      await writeFile(join(tempRepo, 'new-file.txt'), 'newly created\n', 'utf8');

      const patch = await extractPatchDiff(tempRepo, 3, 'HEAD');
      expect(patch.files).toContain('new-file.txt');
      expect(patch.diff).toContain('diff --git a/new-file.txt b/new-file.txt');
      expect(patch.diff).toContain('--- /dev/null');
      expect(patch.diff).toContain('+++ b/new-file.txt');

      // Verify git apply -p1 --check succeeds on clean state
      const patchPath = join(tempRepo, 'new.patch');
      await writeFile(patchPath, patch.diff, 'utf8');
      await rm(join(tempRepo, 'new-file.txt'));

      const applyResult = await git(tempRepo, ['apply', '-p1', '--check', patchPath]);
      expect(applyResult.exitCode).toBe(0);
    });

    it('ensureGitApplyPatch injects standard git headers and prefixes into bare unified diffs', () => {
      const bareDiff = `--- src/core/engine.ts
+++ src/core/engine.ts
@@ -1,3 +1,3 @@
-const v = 1;
+const v = 2;
`;
      const fixed = ensureGitApplyPatch(bareDiff);
      expect(fixed).toContain('diff --git a/src/core/engine.ts b/src/core/engine.ts');
      expect(fixed).toContain('--- a/src/core/engine.ts');
      expect(fixed).toContain('+++ b/src/core/engine.ts');
    });

    it('formatForSubmission preserves a/ and b/ prefixes when preservePrefixes is true', () => {
      const gitDiff = `diff --git a/src/math.ts b/src/math.ts
index abc123..def456 100644
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,2 +1,2 @@
-const x = 1;
+const x = 2;
`;
      const submissionWithPrefixes = formatForSubmission(gitDiff, { preservePrefixes: true });
      expect(submissionWithPrefixes).not.toContain('index abc123');
      expect(submissionWithPrefixes).toContain('--- a/src/math.ts');
      expect(submissionWithPrefixes).toContain('+++ b/src/math.ts');

      const submissionDefault = formatForSubmission(gitDiff);
      expect(submissionDefault).toContain('--- src/math.ts');
      expect(submissionDefault).toContain('+++ src/math.ts');
    });
  });

  describe('2. Untracked Nested Files via git add -N .', () => {
    it('captures newly created files in deeply nested subdirectories', async () => {
      const deepDir = join(tempRepo, 'nested', 'level1', 'level2');
      await mkdir(deepDir, { recursive: true });
      const deepFile = join(deepDir, 'feature.ts');
      await writeFile(deepFile, 'export const deepValue = 42;\n', 'utf8');

      // extractPatchDiff must run git add -N . and include feature.ts
      const patch = await extractPatchDiff(tempRepo, 3, 'HEAD');
      expect(patch.files).toContain('nested/level1/level2/feature.ts');
      expect(patch.diff).toContain('+++ b/nested/level1/level2/feature.ts');
      expect(patch.diff).toContain('+export const deepValue = 42;');
      expect(patch.stats.additions).toBe(1);
    });
  });

  describe('3. Process-Group Cleanup on Repro Timeout', () => {
    it('terminates hanging test process group and reports timeout cleanly', async () => {
      const reproTest: ReproTest = {
        command: 'sh -c "sleep 10"',
        files: [],
        timeoutMs: 150,
      };

      const start = Date.now();
      const result = await runReproTest(tempRepo, reproTest, {});
      const duration = Date.now() - start;

      expect(result.pass).toBe(false);
      expect(result.exitCode).toBeNull();
      // Should exit rapidly near timeoutMs, not 10 seconds
      expect(duration).toBeLessThan(3000);
    });

    it('reports pass true on quick zero-exit commands', async () => {
      const reproTest: ReproTest = {
        command: 'node -e "process.exit(0)"',
        files: [],
      };

      const result = await runReproTest(tempRepo, reproTest, {});
      expect(result.pass).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    it('reports pass false on non-zero exit code', async () => {
      const reproTest: ReproTest = {
        command: 'node -e "console.error(\'Assertion failed\'); process.exit(1)"',
        files: [],
      };

      const result = await runReproTest(tempRepo, reproTest, {});
      expect(result.pass).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('Assertion failed');
    });
  });
});
