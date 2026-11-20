import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git } from '../../../src/git/git.js';
import { executeFastPath, normalizeFastPathAction } from '../../../src/router/fast-path-engine.js';
import { tempDir, tempRepo } from '../../support/tmp.js';

describe('executeFastPath: file reconnaissance', () => {
  it('reads a file into a standard tool_result envelope', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'a.txt'), 'hello fast path\n');

    const result = await executeFastPath({
      action: 'read_file',
      root,
      path: 'a.txt',
      toolUseId: 'tool-1',
    });

    expect(result).toEqual({
      type: 'tool_result',
      toolUseId: 'tool-1',
      content: 'hello fast path\n',
    });
  });

  it('accepts tool-name aliases for reads', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'a.txt'), 'aliased\n');

    const result = await executeFastPath({ action: 'cat', root, path: 'a.txt' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('aliased\n');
    expect(result.toolUseId).toBe('fast-path');
  });

  it('lists a directory tree without dependency folders', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'node_modules/pkg'), { recursive: true });
    await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
    await writeFile(join(root, 'node_modules/pkg/index.js'), 'module.exports = 1;\n');

    const result = await executeFastPath({ action: 'list_directory', root, depth: 2 });

    expect(result.content).toContain('src/');
    expect(result.content).toContain('src/a.ts');
    expect(result.content).not.toContain('node_modules');
  });

  it('returns an error envelope for a path outside the root', async () => {
    const root = await tempDir();

    const result = await executeFastPath({ action: 'read_file', root, path: '../secret.txt' });

    expect(result.type).toBe('tool_result');
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the worktree|credential|denied/i);
  });

  it('returns an error envelope for a missing file', async () => {
    const root = await tempDir();

    const result = await executeFastPath({ action: 'read_file', root, path: 'nope.txt' });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/cannot read/);
  });
});

describe('executeFastPath: search', () => {
  it('finds matches without an LLM or tool round trip', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/a.ts'), 'const needle = 1;\nconst other = 2;\n');

    const result = await executeFastPath({
      action: 'grep',
      root,
      pattern: 'needle',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('src/a.ts:1:');
    expect(result.content).toContain('needle');
  });

  it('returns (no matches) for a harmless miss', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'a.txt'), 'nothing here\n');

    const result = await executeFastPath({ action: 'search', root, pattern: 'zzzz' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('(no matches)');
  });

  it('rejects an invalid regular expression', async () => {
    const root = await tempDir();

    const result = await executeFastPath({ action: 'search', root, pattern: '(' });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/invalid search pattern/);
  });
});

describe('executeFastPath: git queries', () => {
  it('reports working-tree status', async () => {
    const root = await tempRepo();
    await writeFile(join(root, 'a.txt'), 'new file\n');

    const result = await executeFastPath({ action: 'git_status', root });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('a.txt');
  });

  it('reports a diff for a tracked modification', async () => {
    const root = await tempRepo();
    await writeFile(join(root, 'a.txt'), 'old\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'init']);
    await writeFile(join(root, 'a.txt'), 'new\n');

    const result = await executeFastPath({ action: 'git_diff', root });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('-old');
    expect(result.content).toContain('+new');
  });

  it('says (clean) when there is nothing to report', async () => {
    const root = await tempRepo();

    const result = await executeFastPath({ action: 'git status', root });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('(clean)');
  });
});

describe('executeFastPath: preflight', () => {
  it('runs preflight locally and returns its compact note', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');

    const result = await executeFastPath({
      action: 'runPreflight',
      root,
      file: 'a.ts',
      before: '',
      after: 'export const a = 1;\n',
      operation: 'write_file',
    });

    expect(result.type).toBe('tool_result');
    expect(result.isError).toBeUndefined();
    expect(result.content).toMatch(/preflight/);
  });
});

describe('executeFastPath: contract', () => {
  it('rejects unsupported actions without throwing', async () => {
    const root = await tempDir();

    const result = await executeFastPath({ action: 'deploy_to_production', root });

    expect(result.type).toBe('tool_result');
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/cannot handle action/);
  });

  it('normalizes common aliases', () => {
    expect(normalizeFastPathAction('read')).toBe('read_file');
    expect(normalizeFastPathAction('list_directory')).toBe('list_directory');
    expect(normalizeFastPathAction('git status')).toBe('git_status');
    expect(normalizeFastPathAction('git-diff')).toBe('git_diff');
    expect(normalizeFastPathAction('runPreflight')).toBe('run_preflight');
    expect(normalizeFastPathAction('unknown')).toBeUndefined();
  });

  it('completes a local file read well under a model-turn budget', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'a.txt'), 'x\n');

    const started = performance.now();
    await executeFastPath({ action: 'read_file', root, path: 'a.txt' });

    expect(performance.now() - started).toBeLessThan(100);
  });
});
