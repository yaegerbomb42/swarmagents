#!/usr/bin/env node
// Regression test for HOTFIX #9 (deploy lane): a chat with assistant markdown and code blocks must render.
// @shikijs/rehype inside react-markdown's synchronous render threw "`runSync` finished async" and crashed every
// chat with an assistant reply. This bundles the real components/Timeline.tsx (CSS stubbed) and server-renders a
// timeline with user + assistant events: headings, lists, tables, inline code, fenced blocks with/without a
// language, an unknown language, and a streaming reply. Run: npm run test:markdown
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "md-render-")), "bundle.mjs");
const entry = path.join(path.dirname(out), "entry.tsx");
fs.writeFileSync(
  entry,
  `import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Timeline } from ${JSON.stringify(path.join(ROOT, "components/Timeline.tsx"))};
export const render = (events) => renderToString(h(Timeline, { events, onImage: () => {}, session: "t" }));`,
);
await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: out,
  jsx: "automatic",
  loader: { ".css": "empty", ".svg": "text" },
  alias: { "@": ROOT },
  external: ["react", "react-dom", "shiki"],
  nodePaths: [path.join(ROOT, "node_modules")],
  logLevel: "error",
});
// Resolve react from the app's node_modules even though the bundle lives in a temp dir.
fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(path.dirname(out), "node_modules"));
const { render } = await import(pathToFileURL(out).href);

const reply = [
  "# Result",
  "Here is **bold**, _italic_, `inline code` and a [link](https://example.com).",
  "",
  "- one",
  "- two",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "```ts",
  "const answer: number = 42;",
  "console.log(answer);",
  "```",
  "",
  "```",
  "plain block, no language",
  "```",
  "",
  "```notalanguage",
  "x <script>alert(1)</script>",
  "```",
].join("\n");
const now = Date.now();
const events = [
  { id: "u1", ts: now, type: "user", text: "show me code" },
  { id: "a1", ts: now + 1, type: "text", text: reply, done: true },
  { id: "a2", ts: now + 2, type: "text", text: "Streaming with ```js\nlet x = 1", done: false },
];

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) fail++;
};
let html = "";
try {
  html = render(events);
  check("timeline with assistant markdown renders (no throw)", true);
} catch (e) {
  check(`timeline with assistant markdown renders: ${String(e?.message ?? e).split("\n")[0]}`, false);
}
check("heading rendered", /<h1[^>]*>Result<\/h1>/.test(html));
check("table rendered (gfm)", /<table/.test(html));
check("ts code block rendered with its language", /code-lang[^>]*>ts</.test(html) && html.includes("const answer: number = 42;"));
check("no nested <pre> inside <pre>", !/<pre[^>]*>(?:(?!<\/pre>)[\s\S])*<pre/.test(html));
check("code is escaped (no raw <script>)", !html.includes("<script>alert(1)</script>") && html.includes("&lt;script&gt;"));
check("streaming reply renders", html.includes("let x = 1"));
console.log(fail ? `\n${fail} check(s) failed` : "\nmarkdown render: all checks passed");
process.exit(fail ? 1 : 0);
