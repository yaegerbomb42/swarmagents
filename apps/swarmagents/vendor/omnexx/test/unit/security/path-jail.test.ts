import { realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PathJailViolationError,
  assertPathInJail,
  isPathInsideRoot,
} from '../../../src/security/path-jail.js';

const dirs: string[] = [];

async function temp(prefix = 'omnexx-jail-'): Promise<string> {
  const d = realpathSync.native(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map(async (d) => {
      try {
        await chmod(d, 0o755);
      } catch {
        // ignore
      }
      await rm(d, { recursive: true, force: true });
    }),
  );
});

describe('assertPathInJail (8.1/8.2)', () => {
  it('allows legitimate subpaths and returns canonical absolute paths', async () => {
    const root = await temp();
    await mkdir(join(root, 'src', 'nested'), { recursive: true });
    await writeFile(join(root, 'src', 'nested', 'a.ts'), 'ok');

    const resolved = assertPathInJail('src/nested/a.ts', root, 'read');
    expect(resolved).toBe(join(root, 'src', 'nested', 'a.ts'));

    expect(assertPathInJail('./src/nested/a.ts', root)).toBe(resolved);
    expect(assertPathInJail(join(root, 'src', 'nested', 'a.ts'), root)).toBe(resolved);
  });

  it('normalizes paths but keeps them jailed', async () => {
    const root = await temp();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'f.txt'), 'x');
    const resolved = assertPathInJail('src/./sub/../f.txt', root, 'read');
    expect(resolved).toBe(join(root, 'src', 'f.txt'));
  });

  it('allows missing write targets inside the jail (new files)', async () => {
    const root = await temp();
    await mkdir(join(root, 'src'), { recursive: true });
    const resolved = assertPathInJail('src/new/file.ts', root, 'write');
    expect(resolved).toBe(join(root, 'src', 'new', 'file.ts'));
  });

  it('rejects missing read targets by default', async () => {
    const root = await temp();
    expect(() => assertPathInJail('nope.txt', root, 'read')).toThrow(PathJailViolationError);
    try {
      assertPathInJail('nope.txt', root, 'read');
      throw new Error('expected not-found');
    } catch (err) {
      expect(err).toBeInstanceOf(PathJailViolationError);
      expect((err as PathJailViolationError).reason).toBe('not-found');
    }
  });

  it('prevents directory traversal attempts (../, absolute escapes)', async () => {
    const root = await temp();
    const attempts = [
      '../x',
      '../../etc/passwd',
      '/etc/passwd',
      'src/../../outside',
      'a/b/../../../escape',
      '..',
    ];
    for (const p of attempts) {
      expect(() => assertPathInJail(p, root, { mode: 'read', requireExists: false }), p).toThrow(
        PathJailViolationError,
      );
      try {
        assertPathInJail(p, root, { mode: 'read', requireExists: false });
      } catch (err) {
        const e = err as PathJailViolationError;
        expect(['outside-root', 'symlink-escape']).toContain(e.reason);
      }
    }
  });

  it('rejects null-byte injection', async () => {
    const root = await temp();
    expect(() =>
      assertPathInJail('src/file.ts\0.txt', root, { mode: 'write', requireExists: false }),
    ).toThrow(PathJailViolationError);
    try {
      assertPathInJail('bad\0path', root, { mode: 'write', requireExists: false });
      throw new Error('expected null-byte');
    } catch (err) {
      expect(err).toBeInstanceOf(PathJailViolationError);
      expect((err as PathJailViolationError).reason).toBe('null-byte');
    }
  });

  it('blocks malicious symlinks pointing outside root', async () => {
    const root = await temp();
    const outside = await temp('omnexx-outside-');
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(root, 'escape-link'));

    expect(() => assertPathInJail('escape-link/secret.txt', root, 'read')).toThrow(
      PathJailViolationError,
    );
    try {
      assertPathInJail('escape-link/secret.txt', root, 'read');
      throw new Error('expected symlink escape');
    } catch (err) {
      expect(err).toBeInstanceOf(PathJailViolationError);
      expect((err as PathJailViolationError).reason).toBe('symlink-escape');
      expect((err as PathJailViolationError).resolvedPath).toContain('secret.txt');
    }
  });

  it('blocks symlink breakout through a missing tail', async () => {
    const root = await temp();
    const outside = await temp('omnexx-outside-');
    await symlink(outside, join(root, 'link'));
    expect(() =>
      assertPathInJail('link/new/deep/file.txt', root, { mode: 'write', requireExists: false }),
    ).toThrow(PathJailViolationError);
  });

  it('allows symlinks that stay inside the root', async () => {
    const root = await temp();
    await mkdir(join(root, 'real'), { recursive: true });
    await writeFile(join(root, 'real', 'f.txt'), 'ok');
    await symlink(join(root, 'real'), join(root, 'alias'));

    const resolved = assertPathInJail('alias/f.txt', root, 'read');
    expect(resolved).toBe(join(root, 'real', 'f.txt'));
  });

  it('supports read-only vs read-write permission checking', async () => {
    const root = await temp();
    await mkdir(join(root, 'dir'), { recursive: true });
    const ro = join(root, 'dir', 'ro.txt');
    await writeFile(ro, 'x');
    await chmod(ro, 0o444);

    // Read mode should succeed for a readable file.
    expect(assertPathInJail('dir/ro.txt', root, 'read')).toBe(ro);

    // Write mode should fail when the target is read-only.
    try {
      assertPathInJail('dir/ro.txt', root, 'write');
      throw new Error('expected write permission failure');
    } catch (err) {
      expect(err).toBeInstanceOf(PathJailViolationError);
      expect((err as PathJailViolationError).reason).toBe('permission-denied');
    }

    await chmod(ro, 0o644);
  });

  it('enforces write permission on nearest existing ancestor for new files', async () => {
    const root = await temp();
    const locked = join(root, 'locked');
    await mkdir(locked, { recursive: true });
    await chmod(locked, 0o555);
    try {
      assertPathInJail('locked/new.txt', root, 'write');
      throw new Error('expected permission failure');
    } catch (err) {
      expect(err).toBeInstanceOf(PathJailViolationError);
      expect((err as PathJailViolationError).reason).toBe('permission-denied');
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('throws typed PathJailViolationError with useful metadata', async () => {
    const root = await temp();
    try {
      assertPathInJail('../etc/passwd', root, { mode: 'read', requireExists: false });
      throw new Error('expected outside-root');
    } catch (err) {
      expect(err).toBeInstanceOf(PathJailViolationError);
      const e = err as PathJailViolationError;
      expect(e.name).toBe('PathJailViolationError');
      expect(e.candidatePath).toBe('../etc/passwd');
      expect(e.rootDir).toBeTruthy();
      expect(typeof e.reason).toBe('string');
    }
  });

  it('treats a differently-cased root as inside on case-insensitive platforms', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return;
    const root = await temp();
    await writeFile(join(root, 'a.txt'), 'x');
    expect(isPathInsideRoot(root.toUpperCase(), join(root, 'a.txt').toLowerCase())).toBe(true);
  });

  it('does not confuse sibling prefixes (root /a/b vs /a/bc)', () => {
    expect(isPathInsideRoot('/a/b', '/a/bc/file')).toBe(false);
    expect(isPathInsideRoot('/a/b', '/a/b/c')).toBe(true);
  });
});
