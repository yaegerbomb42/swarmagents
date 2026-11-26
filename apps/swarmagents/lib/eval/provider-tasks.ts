// Scripted general-task fixtures for the multi-provider eval.
//
// Six tasks covering the requested categories: coding (fix + implement),
// web (edit an HTML page), file organization, a GUI app source, and a
// non-vision desktop launcher artifact. Every task is self-contained (no
// network, no external MCPs): starting files, a `node --test` verifier,
// and the correct final state. The verifier checks the *produced
// artifact* (source or file contents) — a GUI/desktop window cannot be
// launched headless in CI, so those tasks verify the deliverable's shape,
// which is exactly what a scripted suite can promise.

import type { ProviderEvalTask } from "./provider-types";

function task(t: ProviderEvalTask): ProviderEvalTask {
  return t;
}

export const PROVIDER_EVAL_TASKS: ProviderEvalTask[] = [
  // ---- coding: single-file bug fix ----
  task({
    id: "coding-fix-rate-limiter",
    category: "coding",
    title: "Fix the sliding-window rate limiter off-by-one",
    description: "The limiter admits limit+1 requests per window because allow() increments before checking.",
    prompt:
      "The rate limiter in src/limiter.mjs admits one too many requests per window. Fix it so a limit of N admits exactly N requests inside a window, then denies the (N+1)th.",
    setupFiles: {
      "src/limiter.mjs": `export class SlidingWindowLimiter {
  constructor(limit, windowMs, now = () => Date.now()) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.count = 0;
    this.windowStart = now();
  }
  allow() {
    const t = this.now();
    if (t - this.windowStart >= this.windowMs) {
      this.windowStart = t;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= this.limit + 1;
  }
}
`,
    },
    verifier: {
      path: "test/limiter.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { SlidingWindowLimiter } from "../src/limiter.mjs";

test("admits exactly limit requests per window, then denies", () => {
  let t = 0;
  const limiter = new SlidingWindowLimiter(3, 1000, () => t);
  assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), false);
});

test("a new window admits again", () => {
  let t = 0;
  const limiter = new SlidingWindowLimiter(2, 1000, () => t);
  limiter.allow();
  limiter.allow();
  assert.equal(limiter.allow(), false);
  t = 1001;
  assert.equal(limiter.allow(), true);
});
`,
    },
    solution: {
      files: {
        "src/limiter.mjs": `export class SlidingWindowLimiter {
  constructor(limit, windowMs, now = () => Date.now()) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.count = 0;
    this.windowStart = now();
  }
  allow() {
    const t = this.now();
    if (t - this.windowStart >= this.windowMs) {
      this.windowStart = t;
      this.count = 0;
    }
    if (this.count >= this.limit) return false;
    this.count += 1;
    return true;
  }
}
`,
      },
    },
  }),

  // ---- coding: implement from a stub ----
  task({
    id: "coding-implement-validator",
    category: "coding",
    title: "Implement a schema validator",
    description: "validate() is an unimplemented stub. Return every violation as a message list.",
    prompt:
      "Implement validate(obj, schema) in src/validate.mjs. The schema maps each field name to a rule " +
      "{ required?: boolean, type?: \"string\" | \"number\", min?: number, max?: number, pattern?: RegExp }. " +
      "Check required fields, types, numeric ranges (min/max) and string patterns. Return an array with one message per " +
      "violation, each naming its field; once a field has the wrong type, report only that for it. A valid object returns [].",
    setupFiles: {
      "src/validate.mjs": `export function validate(obj, schema) {
  throw new Error("not implemented");
}
`,
    },
    verifier: {
      path: "test/validate.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/validate.mjs";

const schema = {
  name: { required: true, type: "string", pattern: /^[a-z]+$/ },
  age: { required: true, type: "number", min: 0, max: 120 },
  nick: { required: false, type: "string" },
};

test("a valid object yields no errors", () => {
  assert.deepEqual(validate({ name: "ann", age: 30 }, schema), []);
});

test("missing required fields are reported", () => {
  const errors = validate({ age: 30 }, schema);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /name/);
});

test("wrong types, out-of-range values and bad patterns are all reported", () => {
  const errors = validate({ name: "Ann", age: 200, nick: 7 }, schema);
  assert.equal(errors.length, 3);
  assert.ok(errors.some((e) => e.includes("name")));
  assert.ok(errors.some((e) => e.includes("age")));
  assert.ok(errors.some((e) => e.includes("nick")));
});
`,
    },
    solution: {
      files: {
        "src/validate.mjs": `export function validate(obj, schema) {
  const errors = [];
  for (const [field, rule] of Object.entries(schema)) {
    const value = obj[field];
    if (value === undefined || value === null) {
      if (rule.required) errors.push(field + " is required");
      continue;
    }
    if (rule.type && typeof value !== rule.type) {
      errors.push(field + " must be a " + rule.type);
      continue;
    }
    if (rule.type === "number") {
      if (rule.min !== undefined && value < rule.min) {
        errors.push(field + " must be >= " + rule.min);
      }
      if (rule.max !== undefined && value > rule.max) {
        errors.push(field + " must be <= " + rule.max);
      }
    }
    if (rule.type === "string" && rule.pattern && !rule.pattern.test(value)) {
      errors.push(field + " does not match " + rule.pattern);
    }
  }
  return errors;
}
`,
      },
    },
  }),

  // ---- web: edit an HTML page ----
  task({
    id: "web-add-contact-section",
    category: "web",
    title: "Add a contact section to the landing page",
    description: "The page has no contact section. Add a <section id=\"contact\"> with an anchor link.",
    prompt:
      "Add a contact section to index.html: a <section id=\"contact\"> containing an <h2>Contact</h2> and an email link " +
      "to hello@acme.test (the link text is the address), and update the nav to include an anchor to #contact.",
    setupFiles: {
      "index.html": `<!doctype html>
<html>
  <head><title>Acme</title></head>
  <body>
    <nav><a href="#home">Home</a></nav>
    <main><h1>Welcome</h1></main>
  </body>
</html>
`,
    },
    verifier: {
      path: "test/page.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("page has a contact section with heading and email link, nav anchors to it", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(html.includes('<section id="contact">'));
  assert.ok(html.includes("<h2>Contact</h2>"));
  assert.ok(html.includes("mailto:"));
  assert.ok(html.includes('<a href="#contact">'));
  assert.ok(html.includes('<a href="mailto:hello@acme.test">hello@acme.test</a>'));
});
`,
    },
    solution: {
      files: {
        "index.html": `<!doctype html>
<html>
  <head><title>Acme</title></head>
  <body>
    <nav><a href="#home">Home</a> <a href="#contact">Contact</a></nav>
    <main><h1>Welcome</h1></main>
    <section id="contact">
      <h2>Contact</h2>
      <p>Email <a href="mailto:hello@acme.test">hello@acme.test</a>.</p>
    </section>
  </body>
</html>
`,
      },
    },
  }),

  // ---- file organization ----
  task({
    id: "fileorg-consolidate-logs",
    category: "file-org",
    title: "Organize log files into dated subdirectories",
    description: "Log files sit flat in ./logs. Move each into logs/YYYY-MM/ using its embedded date prefix.",
    prompt:
      "Consolidate the flat log files in logs/ into dated subdirectories logs/YYYY-MM/ based on each file's date prefix (for example logs/2026-01-app.log -> logs/2026-01/app.log). Remove the originals.",
    setupFiles: {
      "logs/2026-01-app.log": "2026-01-05T10:00:00Z info started\n",
      "logs/2026-01-web.log": "2026-01-06T11:00:00Z info listening\n",
      "logs/2026-02-app.log": "2026-02-01T09:00:00Z info started\n",
    },
    verifier: {
      path: "test/logs.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { readdir, stat } from "node:fs/promises";

test("logs are consolidated into YYYY-MM directories and originals removed", async () => {
  const months = await readdir(new URL("../logs", import.meta.url));
  months.sort();
  assert.deepEqual(months, ["2026-01", "2026-02"]);
  const jan = await readdir(new URL("../logs/2026-01", import.meta.url));
  assert.deepEqual(jan.sort(), ["app.log", "web.log"]);
  const feb = await readdir(new URL("../logs/2026-02", import.meta.url));
  assert.deepEqual(feb, ["app.log"]);
  await assert.rejects(stat(new URL("../logs/2026-01-app.log", import.meta.url)));
});
`,
    },
    solution: {
      // The scripted solver writes the consolidated tree and deletes the
      // flat originals; the verifier asserts the final layout. The runner
      // applies the same delta the runner would, then grades.
      files: {
        "logs/2026-01/app.log": "2026-01-05T10:00:00Z info started\n",
        "logs/2026-01/web.log": "2026-01-06T11:00:00Z info listening\n",
        "logs/2026-02/app.log": "2026-02-01T09:00:00Z info started\n",
      },
      deleted: ["logs/2026-01-app.log", "logs/2026-01-web.log", "logs/2026-02-app.log"],
    },
  }),

  // ---- GUI app source ----
  task({
    id: "gui-tkinter-counter-app",
    category: "gui-app",
    title: "Write a Tkinter counter app",
    description: "Create a GUI app: a window titled 'Counter' with a labeled counter that increments on click.",
    prompt:
      "Write app.py using Tkinter: a window titled 'Counter', a label showing a running count, and a button that increments it when clicked.",
    setupFiles: {},
    verifier: {
      path: "test/app.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("app.py imports tkinter and defines a counter window", async () => {
  const src = await readFile(new URL("../app.py", import.meta.url), "utf8");
  assert.match(src, /^\\s*(import tkinter|from tkinter import)/m);
  assert.ok(src.includes("Tk()"));
  assert.ok(src.includes('title("Counter")') || src.includes("title('Counter')"));
  assert.ok(src.includes("Button("));
  assert.ok(src.includes("Label("));
});
`,
    },
    solution: {
      files: {
        "app.py": `import tkinter as tk

root = tk.Tk()
root.title("Counter")
count = 0

label = tk.Label(root, text=str(count))
label.pack()

def increment():
    global count
    count += 1
    label.config(text=str(count))

button = tk.Button(root, text="Increment", command=increment)
button.pack()

root.mainloop()
`,
      },
    },
  }),

  // ---- non-vision desktop artifact ----
  task({
    id: "nonvision-desktop-shortcut",
    category: "non-vision-desktop",
    title: "Create a desktop launcher for a tool",
    description: "Create ~/Desktop/notes.desktop that launches the notes editor with a proper icon and name.",
    prompt:
      "Create a freedesktop launcher at ~/Desktop/notes.desktop named 'Notes' that runs the command 'gedit' with an icon of 'accessories-text-editor'. Make it executable.",
    setupFiles: {},
    verifier: {
      path: "test/launcher.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("desktop launcher exists with correct metadata and is executable", async () => {
  const src = await readFile(new URL("../Desktop/notes.desktop", import.meta.url), "utf8");
  assert.ok(src.includes("[Desktop Entry]"));
  assert.ok(src.includes("Name=Notes"));
  assert.ok(src.includes("Exec=gedit"));
  assert.ok(src.includes("Icon=accessories-text-editor"));
});
`,
    },
    solution: {
      files: {
        "Desktop/notes.desktop": `[Desktop Entry]
Type=Application
Name=Notes
Comment=Notes editor
Exec=gedit
Icon=accessories-text-editor
Terminal=false
Categories=Utility;TextEditor;
`,
      },
    },
  }),
];
