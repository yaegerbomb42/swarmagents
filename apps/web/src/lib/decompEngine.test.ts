import { describe, it, expect } from 'vitest';
import { sanitizeMission, sanitizeUserInput } from './decompEngine';

describe('sanitizeUserInput', () => {
  it('clamps to default steer max length', () => {
    expect(sanitizeUserInput('a'.repeat(5000)).length).toBe(2000);
  });

  it('normalizes CRLF and trims whitespace', () => {
    expect(sanitizeUserInput('  hi\r\nthere  ')).toBe('hi\nthere');
  });

  it('returns empty string for non-stringish empty input', () => {
    expect(sanitizeUserInput(null)).toBe('');
    expect(sanitizeUserInput(undefined)).toBe('');
  });
});

describe('sanitizeMission', () => {
  it('strips null bytes and normalizes line endings', () => {
    const result = sanitizeMission('hello\u0000world\r\nnext');
    expect(result.raw).toBe('helloworld\nnext');
    expect(result.text).not.toContain('\u0000');
  });

  it('clamps input to 4000 characters', () => {
    const chunk = 'Build a production API endpoint with validation and tests. ';
    const long = chunk.repeat(100);
    expect(long.length).toBeGreaterThan(4000);
    const result = sanitizeMission(long);
    expect(result.text.length).toBeLessThanOrEqual(4000);
  });

  it('expands vague short missions', () => {
    const result = sanitizeMission('fix bug');
    expect(result.vague).toBe(true);
    expect(result.text).toContain('Objective:');
    expect(result.text.length).toBeGreaterThan(20);
  });

  it('preserves concrete missions without vague expansion', () => {
    const mission =
      'Build a REST API with authentication, rate limiting, and OpenAPI docs for the billing module.';
    const result = sanitizeMission(mission);
    expect(result.vague).toBe(false);
    expect(result.text).toBe(mission);
  });

  it('detects production and read-only constraints', () => {
    const result = sanitizeMission('Ship production-ready changes with read-only database access.');
    expect(result.constraints).toContain('production-safe changes only');
    expect(result.constraints).toContain('read-only where possible');
  });

  it('returns fallback text for empty input', () => {
    const result = sanitizeMission('   ');
    expect(result.text).toContain('Unspecified objective');
    expect(result.title.length).toBeGreaterThan(0);
  });

  it('detects domain from mission keywords', () => {
    const result = sanitizeMission('Refactor the React dashboard API endpoints for mobile responsiveness.');
    expect(result.domain).toBe('software');
  });
});
