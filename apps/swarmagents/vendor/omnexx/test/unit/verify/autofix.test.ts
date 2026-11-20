import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTOFIX_TIMEOUT_MS, runAutofix } from '../../../src/verify/autofix.js';

/**
 * A minimal flat config with two rules:
 * - built-in `quotes` (a mechanical layout fix),
 * - a local `local/suggestConst` rule whose fix is a *suggestion* (must NOT be applied).
 */
const SUGGEST_RULE_CONFIG = `
export default [
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    plugins: {
      local: {
        rules: {
          suggestConst: {
            meta: { fixable: 'suggestion', messages: { s: 'Prefer const.' } },
            create(context) {
              return {
                VariableDeclaration(node) {
                  if (node.kind === 'let') {
                    context.report({
                      node,
                      messageId: 's',
                      fix(fixer) {
                        return fixer.replaceTextRange([node.range[0], node.range[0] + 3], 'const');
                      },
                    });
                  }
                },
              };
            },
          },
        },
      },
    },
    rules: {
      quotes: ['error', 'single'],
      'local/suggestConst': 'error',
    },
  },
];
`;

const roots: string[] = [];

async function makeProject(config: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'omnexx-autofix-'));
  roots.push(root);
  await writeFile(path.join(root, 'eslint.config.mjs'), config, 'utf8');
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('runAutofix', () => {
  it('applies problem/layout fixes but leaves suggestions untouched', async () => {
    const root = await makeProject(SUGGEST_RULE_CONFIG);
    const filePath = path.join(root, 'sample.js');
    const source = 'const greeting = "hello";\nlet count = 1;\n';

    const result = await runAutofix(root, filePath, source);

    expect(result.fixed).toBe(true);
    // The layout fix (quotes) was applied…
    expect(result.content).toContain("const greeting = 'hello';");
    // …while the suggestion fix (let → const) was not.
    expect(result.content).toContain('let count = 1;');
    expect(result.rulesFixed).toEqual(['quotes']);
  });

  it('returns unchanged when there is nothing to fix', async () => {
    const root = await makeProject(SUGGEST_RULE_CONFIG);
    const filePath = path.join(root, 'clean.js');
    const source = "const ok = 'fine';\n";

    const result = await runAutofix(root, filePath, source);

    expect(result).toEqual({ fixed: false, content: source, rulesFixed: [] });
  });

  it('does not apply suggestion-only fixes', async () => {
    const root = await makeProject(SUGGEST_RULE_CONFIG);
    const filePath = path.join(root, 'suggest.js');
    const source = 'let x = 1;\n';

    const result = await runAutofix(root, filePath, source);

    expect(result.fixed).toBe(false);
    expect(result.content).toBe(source);
    expect(result.rulesFixed).toEqual([]);
  });

  it('degrades to unchanged when the ESLint configuration is broken', async () => {
    const root = await makeProject('export default (() => { throw new Error("boom"); })();\n');
    const filePath = path.join(root, 'x.js');
    const source = 'const a = 1;\n';

    const result = await runAutofix(root, filePath, source);

    expect(result).toEqual({ fixed: false, content: source, rulesFixed: [] });
  });

  it('degrades to unchanged when no configuration is resolvable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'omnexx-autofix-noconfig-'));
    roots.push(root);
    const filePath = path.join(root, 'a.js');
    const source = 'const a = 1;\n';

    const result = await runAutofix(root, filePath, source);

    expect(result).toEqual({ fixed: false, content: source, rulesFixed: [] });
  });

  it('exposes a bounded timeout budget', () => {
    expect(AUTOFIX_TIMEOUT_MS).toBe(1500);
  });
});
