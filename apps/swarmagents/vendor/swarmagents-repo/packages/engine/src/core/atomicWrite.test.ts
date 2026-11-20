import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stageFileAtomic, writeFileAtomic } from './atomicWrite.js';

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'omnexx-atomic-'));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('stageFileAtomic', () => {
  it('writes the file and returns its checksum', async () => {
    const dir = await tempDir();
    const file = join(dir, 'a.txt');
    const checksum = await writeFileAtomic(file, 'hello\n');
    expect(await readFile(file, 'utf8')).toBe('hello\n');
    expect(checksum).toBe(createHash('sha256').update('hello\n').digest('hex'));
  });

  it('runs the validator on the staged bytes and leaves no temp file behind', async () => {
    const dir = await tempDir();
    const file = join(dir, 'a.ts');
    let seen = '';
    await stageFileAtomic(file, 'export const a = 1;\n', {
      validate: (staged) => {
        seen = staged;
      },
    });
    expect(seen).toBe('export const a = 1;\n');
    expect((await readdir(dir)).sort()).toEqual(['a.ts']);
  });

  it('never replaces the target when validation fails', async () => {
    const dir = await tempDir();
    const file = join(dir, 'a.ts');
    await writeFile(file, 'known good\n', 'utf8');

    await expect(
      stageFileAtomic(file, 'export const = ;\n', {
        validate: () => {
          throw new Error('syntax error');
        },
      }),
    ).rejects.toThrow('syntax error');

    expect(await readFile(file, 'utf8')).toBe('known good\n');
    expect((await readdir(dir)).sort()).toEqual(['a.ts']);
  });

  it('cleans up when the parent directory cannot be opened for reading', async () => {
    const dir = await tempDir();
    const file = join(dir, 'nested', 'a.txt');
    await expect(writeFileAtomic(file, 'x')).resolves.toBeTypeOf('string');
    expect(await readFile(file, 'utf8')).toBe('x');
  });
});
