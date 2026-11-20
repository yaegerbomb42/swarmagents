import { describe, expect, it } from 'vitest';
import { validateRole, KNOWN_NATIVE_TOOLS } from './validate.js';

describe('validateRole', () => {
  it('validates a good role', () => {
    const r = validateRole({ id: 'good', name: 'Good' });
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('rejects empty id', () => {
    const r = validateRole({ id: '', name: 'N' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('id'))).toBe(true);
  });

  it('rejects bad id format', () => {
    const r = validateRole({ id: 'BadId', name: 'N' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('kebab-case'))).toBe(true);
  });

  it('rejects empty name', () => {
    const r = validateRole({ id: 'ok', name: '' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('rejects negative maxTurns', () => {
    const r = validateRole({ id: 'ok', name: 'N', maxTurns: -1 });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('maxTurns'))).toBe(true);
  });

  it('warns on unknown tool names without failing validation', () => {
    const r = validateRole({ id: 'ok', name: 'N', allowedTools: ['read', 'nosuchthing'] });
    expect(r.valid).toBe(true);
    expect(r.warnings.some((e) => e.includes('nosuchthing'))).toBe(true);
    expect(r.errors).toHaveLength(0);
  });
});

describe('KNOWN_NATIVE_TOOLS', () => {
  it('includes core tools', () => {
    expect(KNOWN_NATIVE_TOOLS.has('read')).toBe(true);
    expect(KNOWN_NATIVE_TOOLS.has('bash')).toBe(true);
    expect(KNOWN_NATIVE_TOOLS.has('str_replace')).toBe(true);
  });
});
