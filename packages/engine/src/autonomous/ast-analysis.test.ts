import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeFile,
  analyzeSourceText,
  defaultRunCommand,
  extractExpectations,
  isTypeScriptSourcePath,
  parseTypeScript,
} from './ast-analysis.js';

describe('analyzeSourceText', () => {
  it('counts assertions and complexity for valid TypeScript', () => {
    const source = `
      import { expect, it } from 'vitest';
      it('adds', () => {
        expect(1 + 1).toBe(2);
        expect(true).toBe(true);
      });
    `;
    const analysis = analyzeSourceText(source, 'add.test.ts');
    expect(analysis.syntaxErrors).toEqual([]);
    expect(analysis.assertionCount).toBe(2);
    expect(analysis.maxCyclomaticComplexity).toBeGreaterThanOrEqual(1);
  });

  it('reports syntax errors instead of silently analysing a broken file', () => {
    const analysis = analyzeSourceText('export const = ;\nfunction (', 'broken.ts');
    expect(analysis.syntaxErrors.length).toBeGreaterThan(0);
    expect(analysis.syntaxErrors[0]?.message).toBeTruthy();
    expect(analysis.syntaxErrors[0]?.line).toBeGreaterThan(0);
  });

  it('re-parses JSX saved with a .ts extension as TSX', () => {
    const source = `
      export const Card = () => <div className="card">hello</div>;
      export const value = 1;
    `;
    const parsed = parseTypeScript(source, 'Card.ts');
    expect(parsed.diagnostics).toEqual([]);
    const analysis = analyzeSourceText(source, 'Card.ts');
    expect(analysis.syntaxErrors).toEqual([]);
  });

  it('handles TSX generics and nested JSX without diagnostics', () => {
    const source = `
      type Props = { items: string[] };
      export function List({ items }: Props) {
        return (
          <ul>
            {items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        );
      }
    `;
    expect(analyzeSourceText(source, 'List.tsx').syntaxErrors).toEqual([]);
  });
});

describe('extractExpectations', () => {
  it('extracts literal expectations from TSX tests', () => {
    const source = `
      import { expect, it } from 'vitest';
      it('renders', () => {
        expect(render()).toBe('<div />');
        expect(count).not.toBe(0);
      });
    `;
    const found = extractExpectations(source, 'render.test.tsx');
    expect(found.map((a) => a.matcher)).toEqual(['toBe', 'toBe']);
    expect(found[0]?.expected).toBe("'<div />'");
    expect(found[1]?.expected).toBe('0');
  });

  it('returns an empty list rather than throwing on unparseable input', () => {
    expect(() => extractExpectations('it("x", () => { expect(', 'x.ts')).not.toThrow();
    expect(extractExpectations('it("x", () => { expect(', 'x.ts')).toEqual([]);
  });
});

describe('analyzeFile', () => {
  it('surfaces an unreadable file as a diagnostic', () => {
    const analysis = analyzeFile(join(tmpdir(), `missing-${process.pid}-${Date.now()}.ts`));
    expect(analysis.syntaxErrors).toHaveLength(1);
    expect(analysis.syntaxErrors[0]?.message).toContain('cannot read');
    expect(analysis.assertionCount).toBe(0);
  });
});

describe('isTypeScriptSourcePath', () => {
  it('matches only TypeScript source extensions', () => {
    expect(isTypeScriptSourcePath('a.ts')).toBe(true);
    expect(isTypeScriptSourcePath('a.tsx')).toBe(true);
    expect(isTypeScriptSourcePath('a.mts')).toBe(true);
    expect(isTypeScriptSourcePath('a.js')).toBe(false);
    expect(isTypeScriptSourcePath('README.md')).toBe(false);
  });
});

describe('defaultRunCommand', () => {
  it('reports a spawn failure as a normal failed command', async () => {
    const result = await defaultRunCommand('definitely-not-a-real-binary-omnexx-test', [], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.timedOut).toBe(false);
  });
});
