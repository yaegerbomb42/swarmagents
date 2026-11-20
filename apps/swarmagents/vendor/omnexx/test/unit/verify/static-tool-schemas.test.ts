import { describe, expect, it } from 'vitest';
import { toolSpec, WORKER_TOOLS } from '../../../src/tools/registry.js';
import { canonicalizeTools } from '../../../src/agent/context.js';

describe('Step 2.1: Static & Generic Tool Schemas', () => {
  it('contains zero dynamic workspace paths, user dirs, or volatile timestamps in tool specs', () => {
    const specs = WORKER_TOOLS.map(toolSpec);
    expect(specs.length).toBeGreaterThan(10);

    for (const spec of specs) {
      const serialized = JSON.stringify(spec);
      // Assert no local machine absolute paths or timestamps leaked into descriptions or schemas
      expect(serialized).not.toMatch(/\/Users\//);
      expect(serialized).not.toMatch(/\/home\//);
      expect(serialized).not.toMatch(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
      );
      expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  it('serializes to byte-for-byte identical output across separate runs and repoRoot settings', () => {
    const specsSession1 = WORKER_TOOLS.map(toolSpec);
    const specsSession2 = WORKER_TOOLS.map(toolSpec);

    const json1 = JSON.stringify(canonicalizeTools(specsSession1, '/Users/mock/repo1'));
    const json2 = JSON.stringify(canonicalizeTools(specsSession2, '/Users/different/repo2'));

    expect(json1).toBe(json2);
  });

  it('guarantees deterministic alphabetical ordering by tool name', () => {
    const canonical = canonicalizeTools(WORKER_TOOLS.map(toolSpec));
    const names = canonical.map((t) => t.name);
    const sortedNames = [...names].sort((a, b) => a.localeCompare(b));

    expect(names).toEqual(sortedNames);
  });
});
