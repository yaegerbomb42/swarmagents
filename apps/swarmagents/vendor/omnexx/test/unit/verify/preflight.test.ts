import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runPreflight } from '../../../src/verify/preflight.js';
import type { PreflightRequest } from '../../../src/verify/preflight-types.js';
import { tempDir } from '../../support/tmp.js';
import { toolContext } from '../../support/tool-context.js';

/** Minimal flat config: a single mechanical (layout) fix that the pipeline can apply. */
const QUOTES_CONFIG = `
export default [
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2022 },
    rules: { quotes: ['error', 'single'] },
  },
];
`;

const tempRoots: string[] = [];

async function makeProject(config: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'omnexx-preflight-'));
  tempRoots.push(root);
  await writeFile(path.join(root, 'eslint.config.mjs'), config, 'utf8');
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('runPreflight hub', () => {
  it('returns clean status for valid request', async () => {
    const req: PreflightRequest = {
      root: '/fake/root',
      file: 'src/app.ts',
      before: 'const x = 1;',
      after: 'const x = 2;',
      operation: 'str_replace',
    };

    const res = await runPreflight(req);
    expect(res.status).toBe('clean');
    expect(res.diagnostics).toEqual([]);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('aborts and returns skipped when AbortSignal is triggered', async () => {
    const controller = new AbortController();
    const req: PreflightRequest = {
      root: '/fake/root',
      file: 'src/app.ts',
      before: 'const x = 1;',
      after: 'const x = 2;',
      operation: 'str_replace',
      signal: controller.signal,
    };

    controller.abort();
    const res = await runPreflight(req);
    expect(res.status).toBe('skipped');
  });

  it('correctly sets operation and passes through preflight result', async () => {
    const req: PreflightRequest = {
      root: '/fake/root',
      file: 'src/app.ts',
      before: 'export function a() {}',
      after: 'export function a() { return 1; }',
      operation: 'multi_edit',
    };

    const res = await runPreflight(req);
    expect(res.status).toBe('clean');
    expect(res.formatted).toBe(false);
    expect(res.fixed).toBe(0);
  });

  it('runs autofix and passes through fixed content written to disk', async () => {
    const root = await makeProject(QUOTES_CONFIG);
    const file = 'sample.js';
    const req: PreflightRequest = {
      root,
      file,
      before: '',
      after: 'const a = "hi";\n',
      operation: 'edit',
    };

    const res = await runPreflight(req);

    expect(res.fixed).toBeGreaterThan(0);
    expect(res.rulesFixed).toEqual(['quotes']);
    expect(res.content).toContain("const a = 'hi';");
    expect(res.status).toBe('clean');
    // The autofix change is persisted to disk so diagnostics see the clean code.
    const onDisk = await readFile(path.join(root, file), 'utf8');
    expect(onDisk).toBe(res.content);
  });

  it('passes through formatting when a project formatter applies', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'node_modules/.bin'), { recursive: true });
    await writeFile(join(root, '.prettierrc'), '{}');
    const bin = join(root, 'node_modules/.bin/prettier');
    await writeFile(bin, '#!/bin/sh\ncat >/dev/null\nprintf "a {\\n  color: red;\\n}\\n"\n');
    await chmod(bin, 0o755);

    const file = 'stub-preflight-fmt.css';
    const source = 'a{color:red;}\n';
    const req: PreflightRequest = {
      root,
      file,
      before: source,
      after: source,
      operation: 'edit',
    };

    const res = await runPreflight(req);

    expect(res.formatted).toBe(true);
    expect(res.content).not.toBe(source);
    expect(res.fixed).toBe(0);
  });

  it('formats before diagnostics and persists the formatted snippet', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'node_modules/.bin'), { recursive: true });
    await writeFile(join(root, '.prettierrc'), '{}');
    const bin = join(root, 'node_modules/.bin/prettier');
    await writeFile(bin, '#!/bin/sh\ncat >/dev/null\nprintf "const x = 1;\\n"\n');
    await chmod(bin, 0o755);
    const abs = join(root, 'a.ts');
    await writeFile(abs, 'const x=1;\n');
    const ctx = await toolContext(root);

    const res = await runPreflight({
      root,
      file: abs,
      before: '',
      after: 'const x=1;\n',
      operation: 'write_file',
      ctx,
    });

    expect(res.formatted).toBe(true);
    expect(res.tailNote).toContain('Formatted with prettier');
    expect(await readFile(abs, 'utf8')).toBe('const x = 1;\n');
  });

  it('leaves the file untouched when no formatter is configured', async () => {
    const root = await tempDir();
    const abs = join(root, 'a.ts');
    await writeFile(abs, 'const x=1;\n');
    const ctx = await toolContext(root);

    const res = await runPreflight({
      root,
      file: abs,
      before: '',
      after: 'const x=1;\n',
      operation: 'write_file',
      ctx,
    });

    expect(res.formatted).toBe(false);
    expect(await readFile(abs, 'utf8')).toBe('const x=1;\n');
  });
});
