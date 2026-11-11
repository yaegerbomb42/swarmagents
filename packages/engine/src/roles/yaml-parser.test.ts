import { describe, expect, it } from 'vitest';
import { parseYaml } from './yaml-parser.js';

describe('parseYaml', () => {
  it('parses a simple string scalar', () => {
    expect(parseYaml('hello')).toBe('hello');
  });

  it('parses an object', () => {
    const src = 'id: test\nname: Test Role';
    const result = parseYaml(src) as Record<string, unknown>;
    expect(result.id).toBe('test');
    expect(result.name).toBe('Test Role');
  });

  it('parses arrays with dashes', () => {
    const src = `tools:
  - read
  - bash`;
    const result = parseYaml(src) as Record<string, unknown>;
    expect(result.tools).toEqual(['read', 'bash']);
  });

  it('parses booleans and numbers', () => {
    const src = `enabled: true
count: 42
temp: 0.7`;
    const result = parseYaml(src) as Record<string, unknown>;
    expect(result.enabled).toBe(true);
    expect(result.count).toBe(42);
    expect(result.temp).toBe(0.7);
  });

  it('parses null', () => {
    expect(parseYaml('null')).toBe(null);
    expect(parseYaml('~')).toBe(null);
  });

  it('ignores comments', () => {
    const src = `id: test  # this is a comment`;
    const result = parseYaml(src) as Record<string, unknown>;
    expect(result.id).toBe('test');
  });

  it('parses nested objects', () => {
    const src = `modelConfig:
  maxTokens: 4096
  temperature: 0.5`;
    const result = parseYaml(src) as Record<string, unknown>;
    expect(result.modelConfig).toEqual({ maxTokens: 4096, temperature: 0.5 });
  });

  it('parses quoted strings', () => {
    expect(parseYaml('"hello world"')).toBe('hello world');
    expect(parseYaml("'hello world'")).toBe('hello world');
  });

  it('parses an array of objects (roles list)', () => {
    const src = `- id: role-a
  name: Role A
- id: role-b
  name: Role B`;
    const result = parseYaml(src) as Record<string, unknown>[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('role-a');
    expect(result[1]!.id).toBe('role-b');
  });

  it('returns empty object for empty string', () => {
    expect(parseYaml('')).toEqual({});
  });
});
