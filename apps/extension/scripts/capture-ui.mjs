#!/usr/bin/env node
/**
 * Automated headless UI screenshot capture for Omnexx VS Code extension.
 * Starts a zero-dependency local static HTTP server, runs headless Chrome,
 * captures pixel-perfect screenshots of all mock scenarios, and creates an index gallery.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vscodeRoot = path.join(__dirname, '..');
const screenshotsDir = path.join(vscodeRoot, 'screenshots');

fs.mkdirSync(screenshotsDir, { recursive: true });

// Scenarios to capture
const SCENARIOS = [
  { id: '01_welcome', label: '01. Welcome & Empty State' },
  { id: '02_streaming_think', label: '02. Active Streaming & Chain-of-Thought' },
  { id: '03_tools_diffs', label: '03. Tool Execution & Diffs' },
  { id: '04_approval_gate', label: '04. Approval Gate (Command Review)' },
  { id: '05_context_cockpit', label: '05. Context Inspector & Token Cockpit' },
  { id: '06_settings', label: '06. Settings & Model Matrix' },
  { id: '07_sandbox_scrubber', label: '07. Sandbox Scrubber Timeline' },
];

// Detect Chrome binary
function findChrome() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('Could not find Google Chrome binary for headless screenshot capture.');
}

// MIME types
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

// Start local HTTP server
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let reqPath = decodeURIComponent(req.url.split('?')[0]);
      if (reqPath === '/' || reqPath === '') reqPath = '/preview/index.html';

      const filePath = path.join(vscodeRoot, reqPath);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`Not found: ${reqPath}`);
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(filePath).pipe(res);
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

async function capture() {
  const chromePath = findChrome();
  console.log(`Using Chrome: ${chromePath}`);

  const { server, port } = await startServer();
  console.log(`Preview server listening at http://127.0.0.1:${port}`);

  const capturedImages = [];

  try {
    for (const sc of SCENARIOS) {
      const outPath = path.join(screenshotsDir, `${sc.id}.png`);
      const targetUrl = `http://127.0.0.1:${port}/preview/webview.html?scenario=${sc.id}&theme=dark`;

      console.log(`Capturing [${sc.label}] -> screenshots/${sc.id}.png ...`);

      const args = [
        '--headless',
        '--disable-gpu',
        '--hide-scrollbars',
        '--run-all-compositor-stages-before-draw',
        '--window-size=400,820',
        '--virtual-time-budget=2500',
        `--screenshot=${outPath}`,
        targetUrl,
      ];

      try {
        await execFileAsync(chromePath, args);
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
          const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(1);
          console.log(`  ✓ Success (${sizeKb} KB)`);
          capturedImages.push({ ...sc, path: `${sc.id}.png`, sizeKb });
        } else {
          console.warn(`  ✗ Warning: Output file missing or empty for ${sc.id}`);
        }
      } catch (err) {
        console.error(`  ✗ Error capturing ${sc.id}:`, err.message);
      }
    }

    // Generate INDEX.md gallery
    const indexMd = `# Omnexx VS Code UI Gallery

Captured at: \`${new Date().toISOString()}\`
Viewport: **400 × 820 px** (Standard VS Code sidebar panel)
Theme: **VS Code Dark Modern**

---

${capturedImages
  .map(
    (img) => `### ${img.label}

File: \`${img.path}\` (${img.sizeKb} KB)
![${img.label}](./${img.path})

---`,
  )
  .join('\n\n')}
`;

    fs.writeFileSync(path.join(screenshotsDir, 'INDEX.md'), indexMd, 'utf8');
    console.log(`\nGallery written to ${path.join(screenshotsDir, 'INDEX.md')}`);
  } finally {
    server.close();
  }
}

capture().catch((err) => {
  console.error('Capture pipeline failed:', err);
  process.exit(1);
});
