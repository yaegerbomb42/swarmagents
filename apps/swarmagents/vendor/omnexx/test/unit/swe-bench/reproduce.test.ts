import { describe, expect, it } from 'vitest';
import {
  parseReproTest,
  validateReproFails,
  REPRO_DIR,
  type ReproTest,
} from '../../../src/swe-bench/reproduce.js';
import type { Executor } from '../../../src/core/exec.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

describe('reproduce', () => {
  describe('parseReproTest', () => {
    it('parses valid reproduction test', () => {
      const input = {
        command: `node --test ${REPRO_DIR}/test.js`,
        files: [{ path: `${REPRO_DIR}/test.js`, content: 'console.log("test");' }],
      };

      const result = parseReproTest(input);
      expect(result).toEqual(input);
    });

    it('rejects missing object', () => {
      const result = parseReproTest(null);
      expect(typeof result).toBe('string');
    });

    it('rejects command without repro dir', () => {
      const input = {
        command: 'node --test test.js',
        files: [{ path: `${REPRO_DIR}/test.js`, content: 'console.log("test");' }],
      };

      const result = parseReproTest(input);
      expect(typeof result).toBe('string');
      expect(result).toContain(REPRO_DIR);
    });

    it('rejects files outside repro dir', () => {
      const input = {
        command: `node --test ${REPRO_DIR}/test.js`,
        files: [{ path: 'src/test.js', content: 'console.log("test");' }],
      };

      const result = parseReproTest(input);
      expect(typeof result).toBe('string');
    });

    it('rejects multi-line command', () => {
      const input = {
        command: `cd ${REPRO_DIR}\nnode test.js`,
        files: [{ path: `${REPRO_DIR}/test.js`, content: 'console.log("test");' }],
      };

      const result = parseReproTest(input);
      expect(typeof result).toBe('string');
      expect(result).toContain('one line');
    });

    it('rejects empty files array', () => {
      const input = {
        command: `node --test ${REPRO_DIR}/test.js`,
        files: [],
      };

      const result = parseReproTest(input);
      expect(typeof result).toBe('string');
    });

    it('trims excess files to max limit', () => {
      const files = Array.from({ length: 10 }, (_, i) => ({
        path: `${REPRO_DIR}/test${i}.js`,
        content: `console.log(${i});`,
      }));
      const input = {
        command: `node --test ${REPRO_DIR}/test0.js`,
        files,
      };

      const result = parseReproTest(input);
      if (typeof result !== 'string') {
        expect(result.files.length).toBeLessThanOrEqual(3);
      }
    });
  });

  describe('validateReproFails & runReproTest', () => {
    it('accepts valid reproduction failure that matches symptom', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'omnexx-test-repro-'));
      const test: ReproTest = {
        command: `node ${REPRO_DIR}/fail.js`,
        files: [
          { path: `${REPRO_DIR}/fail.js`, content: 'throw new Error("expected bug symptom");' },
        ],
      };

      const mockExecutor: Executor = () =>
        Promise.resolve({
          output: 'AssertionError: expected bug symptom',
          exitCode: 1,
          timedOut: false,
          durationMs: 10,
        });

      try {
        const val = await validateReproFails(dir, test, {}, mockExecutor, /expected bug symptom/);
        expect(val.valid).toBe(true);
        expect(val.result.pass).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects syntax or import errors as invalid reproductions', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'omnexx-test-repro-'));
      const test: ReproTest = {
        command: `node ${REPRO_DIR}/syntax.js`,
        files: [{ path: `${REPRO_DIR}/syntax.js`, content: 'bad syntax {{{' }],
      };

      const mockExecutor: Executor = () =>
        Promise.resolve({
          output: 'SyntaxError: Unexpected token',
          exitCode: 1,
          timedOut: false,
          durationMs: 5,
        });

      try {
        const val = await validateReproFails(dir, test, {}, mockExecutor);
        expect(val.valid).toBe(false);
        expect(val.reason).toContain('syntax');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects test timeouts', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'omnexx-test-repro-'));
      const test: ReproTest = {
        command: `node ${REPRO_DIR}/hang.js`,
        files: [{ path: `${REPRO_DIR}/hang.js`, content: 'while(true){}' }],
      };

      const mockExecutor: Executor = () =>
        Promise.resolve({
          output: '',
          exitCode: 1,
          timedOut: true,
          durationMs: 60000,
        });

      try {
        const val = await validateReproFails(dir, test, {}, mockExecutor);
        expect(val.valid).toBe(false);
        expect(val.reason).toContain('timed out');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
