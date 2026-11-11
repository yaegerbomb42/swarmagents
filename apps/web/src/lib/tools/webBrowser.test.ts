import { describe, it, expect } from 'vitest';
import { searchWeb, fetchWebContent } from './webBrowser';

describe('Real Web Browser Tool', () => {
  it('returns fallback search results on empty/offline search queries', async () => {
    const results = await searchWeb('TypeScript React concurrency');
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBeDefined();
    expect(results[0].url).toBeDefined();
  });

  it('handles invalid or non-existent URL gracefully without throwing', async () => {
    const page = await fetchWebContent('https://invalid-non-existent-domain-test-123.org');
    expect(page).toBeDefined();
    expect(page.statusCode).toBeDefined();
    expect(page.content).toBeDefined();
  });
});
