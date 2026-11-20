import { describe, expect, it } from 'vitest';
import {
  doesFileImportTarget,
  extractImportSpecifiers,
  findReverseImporters,
} from '../../../src/verify/impact-analysis.js';
import { tempDir } from '../../support/tmp.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

describe('impact-analysis (reverse-importer discovery)', () => {
  it('extracts import and require specifiers correctly', () => {
    const code = `
      import { A } from './models/a.js';
      import type { B } from '../types/b';
      const c = require('./c');
      const d = require('external-package'); // external, not relative
    `;
    const specs = extractImportSpecifiers(code);
    expect(specs).toEqual(['./models/a.js', '../types/b', './c']);
  });

  it('identifies if a file directly imports a target file regardless of extension', () => {
    const importer = '/repo/src/service/user.ts';
    const importerText = `import { User } from '../models/user.js';`;
    const target = '/repo/src/models/user.ts';

    expect(doesFileImportTarget(importer, importerText, target)).toBe(true);
    expect(doesFileImportTarget(importer, importerText, '/repo/src/models/other.ts')).toBe(false);
  });

  it('scans candidate files and finds reverse-importers', async () => {
    const root = await tempDir();
    const dir = join(root, 'src');
    await mkdir(dir, { recursive: true });

    const target = join(dir, 'types.ts');
    const consumerA = join(dir, 'consumerA.ts');
    const consumerB = join(dir, 'consumerB.ts');
    const unrelated = join(dir, 'unrelated.ts');

    await writeFile(target, 'export interface Config { timeout: number; }');
    await writeFile(consumerA, 'import { Config } from "./types.js";');
    await writeFile(consumerB, 'import { Config } from "./types";');
    await writeFile(unrelated, 'export const x = 1;');

    const importers = await findReverseImporters(target, [consumerA, consumerB, unrelated]);
    expect(importers).toContain(consumerA);
    expect(importers).toContain(consumerB);
    expect(importers).not.toContain(unrelated);
  });
});
