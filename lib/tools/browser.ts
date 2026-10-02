import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { BROWSER_PROFILE } from "../store";
import { clip, type Tool } from "./types";

// One persistent Chrome for the whole app: visible on a desktop so the user can watch, headless on a
// server without a display. Logins stick between tasks.
let ctxP: Promise<BrowserContext> | null = null;
let current: Page | null = null;
/** Things that happened outside the action itself (downloads, dialogs, new tabs); reported with the next observation. */
const notes: string[] = [];
const pendingDownloads = new Set<Promise<void>>();
let downloadDir = path.join(process.cwd(), "downloads");
// What each numbered element on the last observed page is ("button "Place order""), so an approval
// gate can see what a click on [12] would actually press before it runs.
let lastElements = new Map<number, string>();

/** Plain-words description of what a browser action would act on, from the last observation:
 *  e.g. `button "Place order"` for {action:"click", index:12}. Undefined when unknown. */
export function browserTargetLabel(input: Record<string, unknown>): string | undefined {
  if (input.index != null) return lastElements.get(Number(input.index));
  if (typeof input.text === "string" && input.action !== "type") return `"${input.text}"`;
  if (typeof input.selector === "string") return input.selector;
  return undefined;
}

const headless = () =>
  process.env.SWARM_BROWSER_HEADLESS === "1" ||
  (process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY);

function launchOptions() {
  const exe = process.env.SWARM_CHROME_PATH || process.env.CHROME_PATH;
  const args = ["--window-size=1280,900"];
  if (process.platform === "linux") args.push("--disable-dev-shm-usage");
  if (process.env.SWARM_BROWSER_NO_SANDBOX === "1") args.push("--no-sandbox");
  const h = headless();
  return {
    exe,
    base: {
      headless: h,
      acceptDownloads: true,
      args,
      env: browserEnv(),
      viewport: h ? { width: 1280, height: 860 } : null,
    },
  };
}

/** Chrome doesn't need the server's secrets: drop SWARM_* and anything that looks like a credential. */
function browserEnv() {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("SWARM_") && !/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i.test(k)) env[k] = v;
  return env;
}

function uniquePath(dir: string, name: string) {
  const safe = (name || "download").replace(/[/\\:\0]/g, "_").slice(0, 180);
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let file = path.join(dir, safe);
  for (let i = 2; fs.existsSync(file); i++)
    file = path.join(dir, `${stem} (${i})${ext}`);
  return file;
}

const fmtSize = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 ** 2).toFixed(1)} MB`;

function watch(p: Page) {
  p.on("download", (d) => {
    const job = (async () => {
      try {
        fs.mkdirSync(downloadDir, { recursive: true });
        const file = uniquePath(downloadDir, d.suggestedFilename());
        await d.saveAs(file);
        notes.push(
          `Downloaded ${path.basename(file)} (${fmtSize(fs.statSync(file).size)}) to ${file}`,
        );
      } catch (e) {
        notes.push(
          `Download of ${d.suggestedFilename()} failed: ${(e as Error).message.split("\n")[0]}`,
        );
      }
    })();
    pendingDownloads.add(job);
    job.finally(() => pendingDownloads.delete(job));
  });
  p.on("dialog", (d) => {
    notes.push(
      `Page ${d.type()} dialog: "${d.message().slice(0, 300)}" (accepted)`,
    );
    d.accept(d.type() === "prompt" ? d.defaultValue() : undefined).catch(
      () => {},
    );
  });
}

async function context() {
  if (!ctxP) {
    const { exe, base } = launchOptions();
    ctxP = (
      exe
        ? chromium.launchPersistentContext(BROWSER_PROFILE, {
            ...base,
            executablePath: exe,
          })
        : chromium.launchPersistentContext(BROWSER_PROFILE, {
            ...base,
            channel: "chrome",
          })
    ).catch(() =>
      chromium.launchPersistentContext(BROWSER_PROFILE, {
        ...base,
        viewport: base.viewport ?? { width: 1280, height: 860 },
      }),
    );
    const c = await ctxP.catch((e) => {
      ctxP = null;
      const msg = String((e as Error).message ?? e);
      throw new Error(
        /Executable doesn't exist|not found|ENOENT|install/i.test(msg)
          ? "No Chrome/Chromium is installed for the browser tool. Install Google Chrome (desktop) or chromium (server) and set SWARM_CHROME_PATH if it isn't on the default path."
          : /display|X server|ozone/i.test(msg)
            ? "Chrome couldn't open a window (no display). Set SWARM_BROWSER_HEADLESS=1 to run it headless."
            : `Couldn't start the browser: ${msg.split("\n")[0]}`,
      );
    });
    c.on("close", () => ((ctxP = null), (current = null)));
    c.pages().forEach(watch);
    c.on("page", (p) => {
      watch(p);
      if (current && !current.isClosed())
        notes.push(
          `A new tab opened${p.url() && p.url() !== "about:blank" ? ` (${p.url()})` : ""}; now controlling it. Use tab_switch to go back.`,
        );
      current = p;
    });
  }
  return ctxP;
}

async function page() {
  const c = await context();
  if (!current || current.isClosed())
    current = c.pages().find((p) => !p.isClosed()) ?? (await c.newPage());
  return current;
}

// Label interactive elements with numbers so the model can act by index, like a human pointing.
const SNAPSHOT = `(() => {
  document.querySelectorAll('[data-swarm-id]').forEach(e => e.removeAttribute('data-swarm-id'));
  const sel = 'a,button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[contenteditable=true],[onclick]';
  const out = []; let i = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight * 3) continue;
    const s = getComputedStyle(el); if (s.visibility === 'hidden' || s.display === 'none') continue;
    el.setAttribute('data-swarm-id', ++i);
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.name || el.alt || '').trim().replace(/\\s+/g,' ').slice(0,80);
    const tag = el.tagName.toLowerCase() + (el.type ? '['+el.type+']' : '');
    out.push('['+i+'] '+tag+(label?' "'+label+'"':'')+(el.href?' -> '+el.getAttribute('href').slice(0,80):''));
  }
  const text = document.body.innerText.replace(/\\n\\s*\\n+/g,'\\n').slice(0, 12000);
  return { title: document.title, url: location.href, elements: out.slice(0, 400).join('\\n'), text };
})()`;

async function settleDownloads(ms = 30_000) {
  if (!pendingDownloads.size) return;
  await Promise.race([
    Promise.allSettled([...pendingDownloads]),
    new Promise((r) => setTimeout(r, ms)),
  ]);
  if (pendingDownloads.size)
    notes.push(
      `${pendingDownloads.size} download(s) still in progress; they'll be reported when done.`,
    );
}

const MARKS_ON = `(() => {
  const host = document.createElement('div');
  host.id = '__swarm_marks';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  let n = 0;
  for (const el of document.querySelectorAll('[data-swarm-id]')) {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth || r.width < 2) continue;
    const b = document.createElement('div');
    b.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;outline:2px solid rgba(232,67,147,.9);outline-offset:-1px;border-radius:2px';
    const t = document.createElement('span');
    t.textContent = el.getAttribute('data-swarm-id');
    t.style.cssText = 'position:absolute;left:-1px;top:' + (r.top > 14 ? '-15px' : '0') + ';background:rgb(232,67,147);color:#fff;font:600 11px/14px system-ui,sans-serif;padding:0 3px;border-radius:2px';
    b.appendChild(t); host.appendChild(b);
    if (++n >= 150) break;
  }
  document.documentElement.appendChild(host);
  return n > 0;
})()`;
const MARKS_OFF = `document.getElementById('__swarm_marks')?.remove()`;

async function observe(p: Page, note: string, full = false) {
  // A click may have opened a tab (target=_blank, window.open); report the tab we're now controlling.
  await new Promise((r) => setTimeout(r, 150));
  if (current && current !== p && !current.isClosed()) p = current;
  if (p.isClosed()) p = await page();
  await p
    .waitForLoadState("domcontentloaded", { timeout: 10_000 })
    .catch(() => {});
  await p.waitForTimeout(400);
  await settleDownloads();
  if (notes.length)
    note = `${note}\n${notes
      .splice(0)
      .map((n) => `• ${n}`)
      .join("\n")}`;
  const snap = (await p
    .evaluate(SNAPSHOT)
    .catch(() => ({
      title: "",
      url: p.url(),
      elements: "",
      text: "",
    }))) as Record<string, string>;
  lastElements = new Map(
    String(snap.elements ?? "")
      .split("\n")
      .flatMap((l) => {
        const m = /^\[(\d+)\]\s+(.*?)(?:\s+->\s.*)?$/.exec(l.trim());
        return m ? [[Number(m[1]), m[2]] as [number, string]] : [];
      }),
  );
  // Set-of-marks: draw each element's number on the screenshot so the model (and the user reading the
  // timeline) can match "[12] button" to what's on screen. Removed right after the capture.
  const marks = process.env.SWARM_BROWSER_MARKS !== "0" && (await p.evaluate(MARKS_ON).catch(() => false));
  const shot = await p
    .screenshot({ type: "jpeg", quality: 60 })
    .catch(() => null);
  if (marks) await p.evaluate(MARKS_OFF).catch(() => {});
  const tabs = p.context().pages();
  return {
    content: clip(
      `${note}\nTab ${tabs.indexOf(p) + 1}/${tabs.length}: ${snap.title}\n${snap.url}\n\nInteractive elements:\n${snap.elements || "(none)"}${full ? `\n\nPage text:\n${snap.text}` : ""}`,
      40_000,
    ),
    images: shot
      ? [{ mediaType: "image/jpeg", data: shot.toString("base64") }]
      : undefined,
  };
}

const target = (p: Page, input: Record<string, unknown>) =>
  input.index != null
    ? p.locator(`[data-swarm-id="${input.index}"]`).first()
    : input.selector
      ? p.locator(String(input.selector)).first()
      : p.getByText(String(input.text), { exact: false }).first();

export const browser: Tool = {
  spec: {
    name: "browser",
    description:
      "Control a real Chrome window (visible to the user, persistent logins). Every action returns a screenshot plus numbered interactive elements; target elements by `index` from the latest observation (or `selector` / `text`). Actions: goto(url), click, type(text, submit?), press(key), scroll(dy), select(value), hover, back, forward, reload, read (full page text), eval(js), tab_new(url?), tab_switch(tab), tab_close, wait(ms), screenshot, upload(path, plus index/selector of the file input or the button that opens the picker). Downloads are saved to <cwd>/downloads and reported; alerts/confirms are accepted and reported.",
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "goto",
            "click",
            "type",
            "press",
            "scroll",
            "select",
            "hover",
            "back",
            "forward",
            "reload",
            "read",
            "eval",
            "tab_new",
            "tab_switch",
            "tab_close",
            "wait",
            "screenshot",
            "upload",
          ],
        },
        url: { type: "string" },
        index: { type: "number" },
        selector: { type: "string" },
        text: { type: "string" },
        value: { type: "string" },
        key: { type: "string" },
        submit: { type: "boolean" },
        dy: { type: "number" },
        js: { type: "string" },
        tab: { type: "number" },
        ms: { type: "number" },
        path: {
          type: "string",
          description: "upload: file path (relative to the working directory)",
        },
      },
      required: ["action"],
    },
  },
  async run(input, ctx) {
    downloadDir = path.join(ctx.cwd, "downloads");
    const p = await page();
    try {
      return await act(p, input, ctx.cwd);
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      // Show the model where things stand instead of a bare stack, so it can pick another element.
      const msg = String((e as Error).message ?? e)
        .split("\n")[0]
        .replace(/^locator\.\w+: /, "");
      const out = await observe(
        p,
        `Action ${String(input.action)} failed: ${msg}`,
      ).catch(() => ({
        content: `Action ${String(input.action)} failed: ${msg}`,
      }));
      return { ...out, isError: true };
    }
  },
};

async function act(p: Page, input: Record<string, unknown>, cwd: string) {
  const a = String(input.action);
  const T = { timeout: 15_000 };
  switch (a) {
    case "goto": {
      let url = String(input.url);
      if (!/^[a-z]+:/i.test(url)) url = "https://" + url;
      try {
        const r = await p.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        return observe(p, `Navigated (${r?.status() ?? "?"}).`);
      } catch (e) {
        // Direct links to files (PDF, zip, csv…) start a download instead of a page load.
        if (
          /Download is starting|net::ERR_ABORTED/.test(
            String((e as Error).message),
          )
        )
          return observe(p, `${url} is a file; downloading it.`);
        throw e;
      }
    }
    case "upload": {
      const file = path.resolve(cwd, String(input.path ?? ""));
      if (!input.path || !fs.existsSync(file))
        return { content: `No file at ${file}.`, isError: true };
      const t = target(p, input);
      try {
        await t.setInputFiles(file, { timeout: 5_000 });
      } catch {
        // Not an <input type=file>: click it and answer the file chooser it opens.
        const [chooser] = await Promise.all([
          p.waitForEvent("filechooser", T),
          t.click(T),
        ]);
        await chooser.setFiles(file);
      }
      return observe(p, `Attached ${path.basename(file)}.`);
    }
    case "click":
      await target(p, input).click(T);
      return observe(p, "Clicked.");
    case "type": {
      const t = target(p, input);
      await t
        .fill(String(input.text ?? input.value ?? ""), T)
        .catch(async () => {
          await t.click(T);
          await p.keyboard.type(String(input.text ?? input.value ?? ""));
        });
      if (input.submit) await p.keyboard.press("Enter");
      return observe(p, "Typed.");
    }
    case "press":
      await p.keyboard.press(String(input.key));
      return observe(p, `Pressed ${input.key}.`);
    case "scroll":
      await p.mouse.wheel(0, Number(input.dy ?? 700));
      return observe(p, "Scrolled.");
    case "select":
      await target(p, input).selectOption(String(input.value), T);
      return observe(p, "Selected.");
    case "hover":
      await target(p, input).hover(T);
      return observe(p, "Hovered.");
    case "back":
      await p.goBack();
      return observe(p, "Back.");
    case "forward":
      await p.goForward();
      return observe(p, "Forward.");
    case "reload":
      await p.reload();
      return observe(p, "Reloaded.");
    case "read":
      return observe(p, "Page contents:", true);
    case "eval": {
      const v = await p.evaluate(String(input.js));
      return {
        content: clip(
          typeof v === "string"
            ? v
            : (JSON.stringify(v, null, 2) ?? "undefined"),
          40_000,
        ),
      };
    }
    case "tab_new":
      current = p = await p.context().newPage();
      if (input.url)
        await p.goto(String(input.url), { waitUntil: "domcontentloaded" });
      return observe(p, "Opened tab.");
    case "tab_switch": {
      const tabs = p.context().pages();
      current = p = tabs[Number(input.tab) - 1] ?? p;
      await p.bringToFront();
      return observe(p, "Switched tab.");
    }
    case "tab_close":
      await p.close();
      return observe(await page(), "Closed tab.");
    case "wait":
      await p.waitForTimeout(Math.min(60_000, Number(input.ms ?? 1500)));
      return observe(p, "Waited.");
    default:
      return observe(p, "Current page.");
  }
}
