/**
 * Step 8.3 & 8.4 — container env argument generation + shadow workspace lifecycle.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildContainerRunArgs,
  type ContainerEnvConfig,
} from '../../../src/sandbox/container-env.js';
import {
  cleanupAllShadowsSync,
  provisionShadowWorkspace,
} from '../../../src/sandbox/workspace-manager.js';
import { tempDir } from '../../support/tmp.js';

function baseConfig(overrides: Partial<ContainerEnvConfig> = {}): ContainerEnvConfig {
  return {
    cpuLimit: 2,
    memoryLimitMb: 512,
    airgap: true,
    binds: [{ source: '/host/work', target: '/workspace' }],
    ...overrides,
  };
}

describe('Step 8.3: container env argument generator (docker / podman)', () => {
  it('enforces CPU/memory caps, a none network under airgap, and default read-only binds', () => {
    const args = buildContainerRunArgs(baseConfig(), 'node:22');
    const joined = args.join(' ');
    expect(args[0]).toBe('run');
    expect(joined).toContain('--cpus 2');
    expect(joined).toContain('--memory=512m');
    expect(joined).toContain('--network=none');
    expect(joined).toContain('-v /host/work:/workspace:ro');
    expect(args).toContain('node:22');
  });

  it('omits the network flag when airgap is false', () => {
    const args = buildContainerRunArgs(baseConfig({ airgap: false }), 'node:22');
    expect(args.join(' ')).not.toContain('--network');
  });

  it('mounts explicitly writable binds as rw', () => {
    const args = buildContainerRunArgs(
      baseConfig({ binds: [{ source: '/host/tmp', target: '/tmp', readOnly: false }] }),
      'node:22',
    );
    expect(args.join(' ')).toContain('-v /host/tmp:/tmp:rw');
  });

  it('appends command tokens after the image', () => {
    const args = buildContainerRunArgs(baseConfig(), 'node:22', ['sh', '-c', 'echo hi']);
    expect(args.slice(-4)).toEqual(['node:22', 'sh', '-c', 'echo hi']);
  });
});

describe('Step 8.4: shadow workspace provisioner', () => {
  it('creates an isolated copy and cleans up idempotently', async () => {
    const source = await tempDir();
    await mkdir(join(source, 'src'));
    await writeFile(join(source, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(source, 'README.md'), '# shadow\n');

    const shadow = await provisionShadowWorkspace(source);

    expect(shadow.path).not.toBe(source);
    expect(existsSync(shadow.path)).toBe(true);
    // content is copied
    expect(await readFile(join(shadow.path, 'README.md'), 'utf8')).toBe('# shadow\n');
    expect(await readFile(join(shadow.path, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    // the original is untouched
    expect(await readFile(join(source, 'README.md'), 'utf8')).toBe('# shadow\n');

    await shadow.cleanup();
    expect(existsSync(shadow.path)).toBe(false);
    // idempotent: a second cleanup is a no-op
    await expect(shadow.cleanup()).resolves.toBeUndefined();
  });

  it('rejects a missing or non-directory source root', async () => {
    await expect(provisionShadowWorkspace('/definitely/not/here')).rejects.toThrow(
      /does not exist/,
    );
    const file = join(await tempDir(), 'a.txt');
    await writeFile(file, 'x');
    await expect(provisionShadowWorkspace(file)).rejects.toThrow(/not a directory/);
  });

  it('removes pending shadows on the process-termination path', async () => {
    const source = await tempDir();
    await writeFile(join(source, 'f.txt'), 'x');
    const shadow = await provisionShadowWorkspace(source);
    const shadowPath = shadow.path;
    expect(existsSync(shadowPath)).toBe(true);

    // simulates the `process.on('exit')` hook: synchronous sweep of all active shadows
    cleanupAllShadowsSync();

    expect(existsSync(shadowPath)).toBe(false);
    // the swept shadow's cleanup stays a safe no-op
    await expect(shadow.cleanup()).resolves.toBeUndefined();
  });
});
