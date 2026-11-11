import { describe, it, expect } from 'vitest';
import { buildUnifiedDiff, diffLineOps, parseDiff, toUnifiedPatch } from '@/lib/parseDiff';

describe('parseDiff', () => {
  it('parses additions, deletions, and context', () => {
    const diff = parseDiff(
      'src/foo.ts',
      `@@ -1,2 +1,3 @@
 context
-old
+new
+more`
    );
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(1);
  });

  it('diffLineOps detects insertions and deletions', () => {
    const ops = diffLineOps('alpha\nbeta', 'alpha\ngamma');
    expect(ops.filter((o) => o.type === 'del').map((o) => o.line)).toEqual(['beta']);
    expect(ops.filter((o) => o.type === 'add').map((o) => o.line)).toEqual(['gamma']);
  });

  it('buildUnifiedDiff emits parseable unified diff', () => {
    const raw = buildUnifiedDiff('src/app.ts', 'const x = 1;\n', 'const x = 2;\n');
    expect(raw).toContain('--- a/src/app.ts');
    const parsed = parseDiff('src/app.ts', raw);
    expect(parsed.deletions).toBeGreaterThan(0);
    expect(parsed.additions).toBeGreaterThan(0);
  });

  it('buildUnifiedDiff returns empty when unchanged', () => {
    expect(buildUnifiedDiff('a.ts', 'same', 'same')).toBe('');
  });

  it('builds unified patch', () => {
    const text = `@@ -1,1 +1,1 @@
-old
+new`;
    const parsed = parseDiff('a.txt', text);
    const patch = toUnifiedPatch(parsed, text);
    expect(patch).toContain('+new');
    expect(patch).toContain('-old');
  });
});
