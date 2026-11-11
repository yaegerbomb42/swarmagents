import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, isRobotsDisallowed } from './web_extractor.js';

describe('htmlToMarkdown', () => {
  it('strips nav, ads and cookie banners while preserving article content', () => {
    const html = `<html><head><title>Test Article</title></head><body>
      <nav>Nav Links</nav>
      <div class="ad-banner">BUY NOW</div>
      <div id="cookie-consent">Accept cookies</div>
      <script>var x = 1;</script>
      <article><h1>Real Content</h1><p>This is the actual body paragraph.</p></article>
    </body></html>`;

    const md = htmlToMarkdown(html);
    expect(md).toContain('Real Content');
    expect(md).toContain('actual body paragraph');
    expect(md).not.toContain('BUY NOW');
    expect(md).not.toContain('cookie');
    expect(md).not.toContain('Nav Links');
    expect(md).not.toContain('var x = 1');
  });

  it('falls back to stripped text on minimal HTML', () => {
    const md = htmlToMarkdown('<p>hello <b>world</b></p>');
    expect(md).toContain('hello world');
  });
});

describe('isRobotsDisallowed', () => {
  it('honors disallow rules for User-agent: *', () => {
    const robots = 'User-agent: *\nDisallow: /private/\nDisallow: /admin\n';
    expect(isRobotsDisallowed(robots, '/private/data')).toBe(true);
    expect(isRobotsDisallowed(robots, '/admin')).toBe(true);
    expect(isRobotsDisallowed(robots, '/public')).toBe(false);
  });

  it('ignores rules for other user agents', () => {
    const robots = 'User-agent: Googlebot\nDisallow: /private/\n';
    expect(isRobotsDisallowed(robots, '/private/data')).toBe(false);
  });
});
