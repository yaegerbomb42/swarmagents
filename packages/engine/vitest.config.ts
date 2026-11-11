import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'vscode'],
    globals: false,
    environment: 'node',
    testTimeout: 15_000,
  },
});
