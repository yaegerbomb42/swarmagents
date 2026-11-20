// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
  {
    ignores: [
      'dist/**',
      'vscode/out/**',
      'coverage/**',
      'node_modules/**',
      'test/fixtures/**',
      'bench/suites/*/*/solution/**',
      // Task fixtures: starting repos (buggy on purpose) and hidden checks.
      'bench/suites/*/*/repo/**',
      'bench/suites/*/*/hidden/**',
      'bench/suites/*/lib/**',
      'bench/results/**',
      // Generated evolution candidates (raw LLM output, kept for the record).
      'bench/evolve-prune/candidates/**',
      'test/.build/**',
      'eslint.config.js',
      'vscode/build.mjs',
      // Plain-JS webview asset (terminal drawer controller): not part of any
      // tsconfig, so the project service cannot type-check it — like build.mjs.
      'vscode/media/terminal.js',
      // Visual-testing harness: the preview fixtures and the headless capture
      // runner are plain JS dev tooling, not part of any tsconfig — same as
      // build.mjs above. They are still prettier-formatted (see format:check).
      'vscode/preview/**',
      'vscode/scripts/capture-ui.mjs',
      'scripts/copy-kernel-data.mjs',
      'bench/venv*/**',
      'src/.*/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // This one DOM test is typechecked by the webview tsconfig (DOM lib), not the
          // root one: lint it with that project instead of the default.
          allowDefaultProject: ['test/unit/vscode-roles-providers.test.ts'],
          defaultProject: 'vscode/src/webview/tsconfig.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      // Conflicts with no-non-null-assertion above; we prefer explicit narrowing.
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'off',
    },
  },
  {
    files: ['test/**', 'bench/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      'no-useless-assignment': 'off',
    },
  },
);
