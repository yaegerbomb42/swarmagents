import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatSource, MAX_FORMAT_TIMEOUT_MS } from '../../../src/verify/formatters.js';
import { tempDir } from '../../support/tmp.js';

async function executable(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  await chmod(path, 0o755);
}

/** A fake formatter that echoes stdin with a tool-specific marker. */
function echoFormatter(marker: string, requiredArg: string): string {
  return `#!/bin/sh
case " $* " in
  *" ${requiredArg} "*) ;;
  *) echo "missing ${requiredArg}" >&2; exit 2 ;;
esac
cat >/dev/null
printf '${marker}\\n'
`;
}

describe('formatSource', () => {
  it('formats TypeScript with the project-local Prettier over stdin', async () => {
    const root = await tempDir();
    await writeFile(join(root, '.prettierrc'), '{}');
    await executable(
      join(root, 'node_modules/.bin/prettier'),
      echoFormatter('const a = 1;', '--stdin-filepath'),
    );

    const result = await formatSource(root, 'src/a.ts', 'const a=1;\n');

    expect(result.formatted).toBe(true);
    expect(result.toolUsed).toBe('prettier');
    expect(result.content).toBe('const a = 1;\n');
  });

  it('formats Python with a project-local Ruff and respects ruff config gating', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'pyproject.toml'), '[tool.ruff]\nline-length = 100\n');
    await executable(
      join(root, '.venv/bin/ruff'),
      echoFormatter('# ruff formatted', '--stdin-filename'),
    );

    const result = await formatSource(root, 'pkg/mod.py', 'x=1\n');

    expect(result.formatted).toBe(true);
    expect(result.toolUsed).toBe('ruff');
    expect(result.content).toBe('# ruff formatted\n');
  });

  it('formats Go with gofmt', async () => {
    const root = await tempDir();
    await executable(
      join(root, 'bin/gofmt'),
      '#!/bin/sh\ncat >/dev/null\nprintf "package main\\n"\n',
    );

    const result = await formatSource(root, 'cmd/main.go', 'package    main\n');

    expect(result.formatted).toBe(true);
    expect(result.toolUsed).toBe('gofmt');
    expect(result.content).toBe('package main\n');
  });

  it('formats Rust with rustfmt', async () => {
    const root = await tempDir();
    await executable(
      join(root, '.bin/rustfmt'),
      '#!/bin/sh\ncat >/dev/null\nprintf "fn main() {}\\n"\n',
    );

    const result = await formatSource(root, 'src/lib.rs', 'fn  main(){}\n');

    expect(result.formatted).toBe(true);
    expect(result.toolUsed).toBe('rustfmt');
    expect(result.content).toBe('fn main() {}\n');
  });

  it('leaves unsupported files untouched without spawning a tool', async () => {
    const root = await tempDir();
    const content = 'plain text\n';

    const result = await formatSource(root, 'notes.txt', content);

    expect(result).toEqual({ formatted: false, content });
  });

  it('degrades when the project formatter is not installed', async () => {
    const root = await tempDir();
    await writeFile(join(root, '.prettierrc'), '{}');
    const content = 'const a=1;\n';

    const result = await formatSource(root, 'a.ts', content);

    expect(result).toEqual({ formatted: false, content });
  });

  it('does not format TypeScript without a Prettier config', async () => {
    const root = await tempDir();
    await executable(
      join(root, 'node_modules/.bin/prettier'),
      echoFormatter('formatted', '--stdin-filepath'),
    );
    const content = 'const a=1;\n';

    const result = await formatSource(root, 'a.ts', content);

    expect(result).toEqual({ formatted: false, content });
  });

  it('degrades on a non-zero exit instead of surfacing stderr', async () => {
    const root = await tempDir();
    await writeFile(join(root, '.prettierrc'), '{}');
    await executable(
      join(root, 'node_modules/.bin/prettier'),
      '#!/bin/sh\ncat >/dev/null\necho "syntax error" >&2\nexit 1\n',
    );
    const content = 'const a=1;\n';

    const result = await formatSource(root, 'a.ts', content);

    expect(result).toEqual({ formatted: false, content });
  });

  it('kills a formatter that exceeds the timeout and returns the original content', async () => {
    const root = await tempDir();
    await writeFile(join(root, '.prettierrc'), '{}');
    await executable(
      join(root, 'node_modules/.bin/prettier'),
      '#!/bin/sh\nsleep 5\ncat >/dev/null\nprintf "late"\\n',
    );
    const content = 'const a=1;\n';
    const started = Date.now();

    const result = await formatSource(root, 'a.ts', content, 30);

    expect(result).toEqual({ formatted: false, content });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('caps an over-long timeout at the 500ms ceiling', async () => {
    expect(MAX_FORMAT_TIMEOUT_MS).toBe(500);
    const root = await tempDir();
    await writeFile(join(root, '.prettierrc'), '{}');
    await executable(
      join(root, 'node_modules/.bin/prettier'),
      '#!/bin/sh\nsleep 5\ncat >/dev/null\nprintf "late"\\n',
    );
    const content = 'const a=1;\n';
    const started = Date.now();

    const result = await formatSource(root, 'a.ts', content, 60_000);

    expect(result).toEqual({ formatted: false, content });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
