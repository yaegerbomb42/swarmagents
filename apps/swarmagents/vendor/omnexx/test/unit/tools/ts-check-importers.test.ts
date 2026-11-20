import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkTs, disposeCheckers } from '../../../src/tools/ts-check.js';
import { tempDir } from '../../support/tmp.js';

afterAll(disposeCheckers);

describe('TypeScript worker reverse-importer diagnostics', () => {
  it('detects breaking changes in reverse-importers when an exported type is modified', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await symlink(resolve('node_modules/typescript'), join(root, 'node_modules/typescript'));

    const tsconfig = {
      compilerOptions: {
        strict: true,
        noEmit: true,
        moduleResolution: 'node',
        target: 'ES2022',
      },
      include: ['src/**/*'],
    };
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify(tsconfig));

    const typesPath = join(root, 'src/types.ts');
    const consumerPath = join(root, 'src/consumer.ts');

    const typesBefore = 'export interface User { id: number; name: string; }\n';
    const consumerContent =
      'import { User } from "./types";\nexport function getName(u: User): string { return u.name; }\n';

    await writeFile(typesPath, typesBefore);
    await writeFile(consumerPath, consumerContent);

    // Edit types.ts to remove 'name' field
    const typesAfter = 'export interface User { id: number; }\n';

    const result = await checkTs(root, typesPath, typesBefore, typesAfter, 60_000);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.before).toHaveLength(0);
      // 'after' must include the compiler error on consumer.ts
      const consumerDiag = result.after.find(
        (d) => d.file?.includes('consumer.ts') && d.message.includes('name'),
      );
      expect(consumerDiag).toBeDefined();
      expect(consumerDiag?.code).toBe('TS2339');
    }
  }, 90_000);
});
