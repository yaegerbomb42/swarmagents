// Live desktop tasks for the provider eval (core-36).
//
// The coding suites (provider-tasks.ts, provider-tasks-hard.ts) never touch
// the A1 desktop, so they say nothing about whether a provider can drive it.
// These tasks boot a throwaway Xvfb display (lib/eval/desktop-session.ts),
// give the agent ONLY the computer-mcp tools (shell and file tools denied),
// and grade the workspace with an ordinary node --test verifier. They need
// Xvfb, xdotool, scrot, ImageMagick and xterm on the host, so they are never
// in the default set: run them with `--tasks desktop`.
//
// Each verifier fails the untouched setup and passes the reference solution
// (lib/eval/provider-tasks.test.ts enforces both, like the other suites).

import { randomBytes } from "node:crypto";
import type { DesktopApp } from "./desktop-session";
import type { ProviderEvalTask } from "./provider-types";

/** A titled xterm running an interactive bash that keeps its title. */
export function xtermApp(title: string, cwd: string | undefined, geometry: string, extra: string[] = ["bash", "--noprofile", "--norc", "-i"]): DesktopApp {
  return {
    cmd: ["xterm", "-T", title, "-xrm", "XTerm*allowTitleOps: false", "-fa", "Monospace", "-fs", "13", "-geometry", geometry, "-e", ...extra],
    ...(cwd ? { cwd } : {}),
    waitForTitle: title,
  };
}

/** Fresh per process so a model cannot have memorised it. */
export const DESKTOP_SECRET_CODE = `DESK-${randomBytes(3).toString("hex").toUpperCase()}`;

export const DESKTOP_PROVIDER_EVAL_TASKS: ProviderEvalTask[] = [
  {
    id: "desktop-terminal-write-file",
    category: "desktop",
    desktop: { apps: [] },
    title: "Open a terminal and create a file by typing",
    description: "Empty desktop. The agent must open a terminal with open_app, focus it and type commands; it has no shell or file tools.",
    prompt: "Open a terminal on the desktop and use it to create the file desk/hello.txt in the working directory containing exactly one line: hello from the desktop",
    setupFiles: { "README.txt": "Desktop eval workspace.\n" },
    verifier: {
      path: "test/desktop-hello.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("desk/hello.txt holds the requested line", () => {
  const text = readFileSync(new URL("../desk/hello.txt", import.meta.url), "utf8");
  assert.equal(text.trim(), "hello from the desktop");
});
`,
    },
    solution: { files: { "desk/hello.txt": "hello from the desktop\n" } },
  },
  {
    id: "desktop-pick-the-right-window",
    category: "desktop",
    desktop: {
      apps: [xtermApp("alpha", "w1", "80x18+20+20"), xtermApp("beta", "w2", "80x18+640+380")],
    },
    title: "Act in the right one of two terminals",
    description: "Two terminals sit in different directories that the prompt does not name. Only typing into the window titled beta lands the file in the right place.",
    prompt: "Two terminal windows are open, titled alpha and beta. In the beta window, create an empty file named marker.txt in that terminal's current directory. Do not create anything from the alpha window.",
    setupFiles: { "w1/notes.txt": "alpha's directory\n", "w2/notes.txt": "beta's directory\n" },
    verifier: {
      path: "test/desktop-window.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

const at = (p) => existsSync(new URL("../" + p, import.meta.url));

test("marker.txt exists in beta's directory", () => {
  assert.equal(at("w2/marker.txt"), true);
});

test("nothing was created from the alpha window or the workspace root", () => {
  assert.equal(at("w1/marker.txt"), false);
  assert.equal(at("marker.txt"), false);
});
`,
    },
    solution: { files: { "w2/marker.txt": "" } },
  },
  {
    id: "desktop-read-code-from-screen",
    category: "desktop",
    desktop: {
      apps: [
        xtermApp("secret", undefined, "60x8+40+40", [
          "sh",
          "-c",
          `printf '\\n  The access code is: %s\\n' "$0"; exec sleep 86400`,
          DESKTOP_SECRET_CODE,
        ]),
      ],
    },
    title: "Read a value off the screen and type it elsewhere",
    description: "A terminal shows a code generated for this run. The agent must read it from a screenshot and write it to a file through a second terminal.",
    prompt: "A terminal window titled secret shows an access code. Open a new terminal and write that code, and nothing else, to code.txt in the working directory.",
    setupFiles: { "README.txt": "Desktop eval workspace.\n" },
    verifier: {
      path: "test/desktop-code.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("code.txt holds the code shown on screen", () => {
  const text = readFileSync(new URL("../code.txt", import.meta.url), "utf8");
  assert.equal(text.trim(), ${JSON.stringify(DESKTOP_SECRET_CODE)});
});
`,
    },
    solution: { files: { "code.txt": `${DESKTOP_SECRET_CODE}\n` } },
  },
];
