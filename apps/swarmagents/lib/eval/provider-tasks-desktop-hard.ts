// Harder live desktop tasks for the provider eval (core-39).
//
// After core-37 both nemotron and mercury solve the core-36 desktop set 3/3,
// so it no longer separates models. These tasks need real GUI work the way a
// user's general task does: read a value only a browser renders, read a
// terminal command's output, and get through LibreOffice's import and save
// dialogs. Selected with `--tasks desktop-hard` (never by `desktop`, so the
// core-36 baseline stays comparable). Values are drawn per process so a model
// cannot have memorised them. Same rules as provider-tasks-desktop.ts: only
// computer-mcp is wired, and every verifier fails the untouched setup and
// passes the reference solution (provider-tasks.test.ts).

import { randomInt } from "node:crypto";
import { firstOnPath, type DesktopApp } from "./desktop-session";
import type { ProviderEvalTask } from "./provider-types";

/** Chromium on the A1 image; google-chrome on many dev hosts. */
const BROWSER = firstOnPath(["chromium", "chromium-browser", "google-chrome"]) ?? "chromium";

/** A page-only browser window (app mode: the window title is the page title). */
function browserApp(fileInWorkspace: string, title: string): DesktopApp {
  return {
    cmd: [
      BROWSER,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--user-data-dir={HOME}/.eval-browser",
      "--window-size=900,600",
      "--window-position=60,60",
      `--app=file://{HOME}/${fileInWorkspace}`,
    ],
    waitForTitle: title,
  };
}

// ---- browser: a value that exists only after JavaScript runs ----
const ORDER_PARTS = [randomInt(11, 40), randomInt(11, 40), randomInt(11, 40)];
/** total = ((p0*3)+p1)*3+p2, computed in the page, never written in the HTML. */
export const ORDER_TOTAL = ORDER_PARTS.reduce((acc, p) => acc * 3 + p, 0);
const ORDER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Order summary</title></head>
<body style="font:30px sans-serif;padding:48px;background:#fff;color:#111">
<h1 style="font-size:34px">Order summary</h1>
<p id="total">Calculating...</p>
<script>
  const parts = ${JSON.stringify(ORDER_PARTS)};
  document.getElementById("total").textContent = "Order total: " + parts.reduce((a, p) => a * 3 + p, 0) + " credits";
</script>
</body></html>
`;

// ---- terminal: which log has the error ----
const LOG_NAMES = ["alpha", "bravo", "charlie", "delta"] as const;
export const ERROR_LOG = `${LOG_NAMES[randomInt(LOG_NAMES.length)]}.log`;
function logFile(name: string): string {
  const lines: string[] = [];
  const errorAt = randomInt(8, 32);
  for (let i = 0; i < 40; i++) {
    const t = `2026-11-26T10:${String(10 + Math.floor(i / 2)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}Z`;
    lines.push(
      name === ERROR_LOG && i === errorAt
        ? `${t} ERROR storage quota exceeded on /var/data (${randomInt(100, 999)} MB over)`
        : `${t} INFO request ${1000 + i} served in ${randomInt(3, 90)}ms`,
    );
  }
  return lines.join("\n") + "\n";
}

// ---- spreadsheet: import dialog, formula, keep-format save dialog ----
const SALES_ROWS: Array<[string, number]> = [
  ["rent", randomInt(900, 1500)],
  ["food", randomInt(200, 600)],
  ["fuel", randomInt(40, 200)],
  ["phone", randomInt(20, 90)],
];
export const SALES_TOTAL = SALES_ROWS.reduce((acc, [, v]) => acc + v, 0);
const SALES_CSV = ["item,amount", ...SALES_ROWS.map(([k, v]) => `${k},${v}`)].join("\n") + "\n";

export const DESKTOP_HARD_PROVIDER_EVAL_TASKS: ProviderEvalTask[] = [
  {
    id: "desktop-browser-rendered-value",
    category: "desktop",
    difficulty: "hard",
    desktop: { apps: [browserApp("desk/order.html", "Order summary")], requires: [BROWSER] },
    title: "Read a value that only the rendered web page shows",
    description: "A browser window shows an order total computed by JavaScript at render time; the number is not in the HTML source.",
    prompt:
      "A browser window titled Order summary is open on the desktop. Read the order total it shows and write just that number (digits only) to total.txt in the working directory. You can use a terminal on the desktop to write the file.",
    setupFiles: { "desk/order.html": ORDER_HTML },
    verifier: {
      path: "test/desktop-browser.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("total.txt holds the rendered order total", () => {
  const text = readFileSync(new URL("../total.txt", import.meta.url), "utf8");
  assert.equal(text.trim(), ${JSON.stringify(String(ORDER_TOTAL))});
});
`,
    },
    solution: { files: { "total.txt": `${ORDER_TOTAL}\n` } },
  },
  {
    id: "desktop-find-error-log",
    category: "desktop",
    difficulty: "hard",
    desktop: { apps: [] },
    title: "Find the failing log from a terminal",
    description: "Four logs, one of which (chosen per run) has an ERROR line. The agent must open a terminal, search, and act on the output.",
    prompt:
      "The logs directory in the working directory holds four log files. Using a terminal on the desktop, find the one file that contains a line with ERROR, and write only that file's name (for example bravo.log) to answer.txt in the working directory.",
    setupFiles: Object.fromEntries(LOG_NAMES.map((n) => [`logs/${n}.log`, logFile(`${n}.log`)])),
    verifier: {
      path: "test/desktop-error-log.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("answer.txt names the log with the ERROR line", () => {
  const text = readFileSync(new URL("../answer.txt", import.meta.url), "utf8").trim();
  // The bare name is asked for; a logs/ prefix is the same answer.
  assert.equal(text.replace(/^(\\.\\/)?logs\\//, ""), ${JSON.stringify(ERROR_LOG)});
});
`,
    },
    solution: { files: { "answer.txt": `${ERROR_LOG}\n` } },
  },
  {
    id: "desktop-spreadsheet-total",
    category: "desktop",
    difficulty: "hard",
    desktop: {
      // No waitForTitle: LibreOffice first shows its Text Import dialog, and
      // getting through it is part of the task.
      apps: [{ cmd: ["soffice", "--calc", "--norestore", "--nologo", "{HOME}/data/sales.csv"] }],
      requires: ["soffice"],
    },
    title: "Add a SUM row in LibreOffice Calc and save as CSV",
    description: "sales.csv opens in Calc behind a Text Import dialog; the agent must add a total row with a formula and save through the Keep Current Format dialog.",
    prompt:
      "LibreOffice Calc is opening data/sales.csv (it may first show a Text Import dialog: accept it with OK; it can take a few seconds to appear). In the spreadsheet, add one row below the data with the text total in column A and, in column B, a SUM formula over the amounts above it. Save the file back to data/sales.csv in CSV format (if asked, keep the current format). Leave the existing rows unchanged.",
    setupFiles: { "data/sales.csv": SALES_CSV },
    verifier: {
      path: "test/desktop-spreadsheet.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rows = () =>
  readFileSync(new URL("../data/sales.csv", import.meta.url), "utf8")
    .split(/\\r?\\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => l.split(",").map((c) => c.trim().replace(/^"(.*)"$/, "$1")));

test("the original rows are unchanged", () => {
  const r = rows();
  assert.deepEqual(r.slice(0, ${SALES_ROWS.length + 1}), ${JSON.stringify([["item", "amount"], ...SALES_ROWS.map(([k, v]) => [k, String(v)])])});
});

test("a total row with the sum follows the data", () => {
  const r = rows();
  assert.equal(r.length, ${SALES_ROWS.length + 2});
  assert.equal(r.at(-1)[0].toLowerCase(), "total");
  assert.equal(Number(r.at(-1)[1]), ${SALES_TOTAL});
});
`,
    },
    solution: { files: { "data/sales.csv": `${SALES_CSV}total,${SALES_TOTAL}\n` } },
  },
];
