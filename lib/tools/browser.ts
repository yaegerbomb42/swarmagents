import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { browserRuntime, type BrowserSession } from "../browser";
import { clip, type Tool } from "./types";

// The tool is a thin layer over lib/browser (the browser runtime): every task gets its own isolated
// Chromium context, profile and downloads folder with hard limits, the runtime watches downloads,
// dialogs and popups, and it streams a CDP screencast to the live viewer. This file turns model
// actions into page operations plus the compact observation the model reasons from.
//
// Control lives in the runtime: if the user has hit "Take over" (a login, a 2FA code, a captcha), the
// next action waits until they hand the browser back instead of fighting them for the mouse.

/** What each numbered element on the last observed page is ("button \"Place order\""), so an approval
 *  gate can see what a click on [12] would actually press before it runs. Keyed by task so a
 *  sub-agent never reads another task's labels; `lastElements` tracks the most recent task. */
const elementsByTask = new Map<string, Map<number, string>>();
let lastElements = new Map<number, string>();

/** Plain-words description of what a browser action would act on, from the last observation:
 *  e.g. `button "Place order"` for {action:"click", index:12}. Undefined when unknown. */
export function browserTargetLabel(input: Record<string, unknown>): string | undefined {
  if (input.index != null) return lastElements.get(Number(input.index));
  if (typeof input.text === "string" && input.action !== "type") return `"${input.text}"`;
  if (typeof input.selector === "string") return input.selector;
  return undefined;
}

/** The task's browser session (created on first use) and the label map the approval gate reads. */
export function browserSession(key: string): BrowserSession {
  const s = browserRuntime().acquire(key);
  let labels = elementsByTask.get(key);
  if (!labels) {
    labels = new Map();
    if (elementsByTask.size > 64) elementsByTask.delete(elementsByTask.keys().next().value as string);
    elementsByTask.set(key, labels);
  }
  lastElements = labels;
  return s;
}

// Snapshot / observation helpers only from here on: launching, limits, downloads, dialogs, tabs and
// the screencast all belong to lib/browser/runtime.ts.

// Watch/launch/tabs/downloads/dialogs now come from BrowserSession (lib/browser/runtime.ts).

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

async function observe(s: BrowserSession, p0: Page, note: string, full = false, wantShot = true) {
  // A click may have opened a tab (target=_blank, window.open); report the tab we're now controlling.
  await new Promise((r) => setTimeout(r, 150));
  let p = p0;
  try {
    const active = await s.page();
    if (!active.isClosed() && active !== p) p = active;
  } catch {}
  if (p.isClosed()) p = await s.page();
  await p
    .waitForLoadState("domcontentloaded", { timeout: 10_000 })
    .catch(() => {});
  await p.waitForTimeout(400);
  await s.settleDownloads();
  const happenings = s.drainNotes();
  if (happenings.length) note = `${note}\n${happenings.map((n) => `• ${n}`).join("\n")}`;
  const snap = (await p
    .evaluate(SNAPSHOT)
    .catch(() => ({
      title: "",
      url: p.url(),
      elements: "",
      text: "",
    }))) as Record<string, string>;
  // Refill in place: browserTargetLabel reads this same Map for the approval gate.
  lastElements.clear();
  for (const l of String(snap.elements ?? "").split("\n")) {
    const m = /^\[(\d+)\]\s+(.*?)(?:\s+->\s.*)?$/.exec(l.trim());
    if (m) lastElements.set(Number(m[1]), m[2]);
  }
  // Set-of-marks: draw each element's number on the screenshot so the model (and the user reading the
  // timeline) can match "[12] button" to what's on screen. Removed right after the capture.
  const marks = wantShot && process.env.SWARM_BROWSER_MARKS !== "0" && (await p.evaluate(MARKS_ON).catch(() => false));
  const shot = wantShot
    ? await p
        .screenshot({ type: "jpeg", quality: 55 })
        .catch(() => null)
    : null;
  if (marks) await p.evaluate(MARKS_OFF).catch(() => {});
  const tabs = s.livePages();
  return {
    content: clip(
      `${note}\nTab ${tabs.indexOf(p) + 1}/${tabs.length}: ${snap.title}\n${snap.url}\n\nInteractive elements:\n${snap.elements || "(none)"}${full ? `\n\nPage text:\n${snap.text}` : ""}`,
      40_000,
    ),
    images: shot ? [{ mediaType: "image/jpeg", data: shot.toString("base64") }] : undefined,
  };
}

const target = (p: Page, input: Record<string, unknown>) =>
  input.index != null
    ? p.locator(`[data-swarm-id="${input.index}"]`).first()
    : input.selector
      ? p.locator(String(input.selector)).first()
      : p.getByText(String(input.text), { exact: false }).first();

/**
 * Wait while the user holds the browser (after "Take over") or while it is paused, so a login, a 2FA
 * code or a captcha is theirs to finish. Resolves false when it is safe to act, true if we were stopped.
 */
function waitWhileTaken(s: BrowserSession, signal: AbortSignal): Promise<boolean> {
  if (s.controller !== "user" && !s.paused) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const finish = (stopped: boolean) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", finishSignal);
      resolve(stopped);
    };
    const finishSignal = () => finish(true);
    signal.addEventListener("abort", finishSignal, { once: true });
    s.whenAgentTurn().then(() => finish(false));
  });
}

export const browser: Tool = {
  spec: {
    name: "browser",
    description:
      "Drive a real browser, isolated per task (its own profile, logins, downloads; limits on tabs, download size and session time). Every action returns a compact observation — tab number, URL, title, numbered interactive elements and anything that happened along the way (downloads, dialogs, new tabs). Pass screenshot:false to skip the image when you are reasoning from the text alone. Target elements by `index` from the latest observation, or `selector` / `text`, or by x/y page coordinates as a screenshot fallback. Actions: goto(url), click, type(text, submit?), press(key), scroll(dy), select(value), hover, drag (from_index/from_selector → to_index/to_selector), back, forward, reload, read (full page text), eval(js), wait(ms), wait_for(selector or text, state, timeout_ms), tab_new(url?), tab_switch(tab), tab_close, screenshot, upload(path, plus index/selector of the file input or the button that opens the picker). Downloads land in <cwd>/downloads and are checked for type and size; alerts/confirms are accepted and reported. If you hit a captcha or a sign-in wall, say so and stop — the user can press Take over in the live view to finish it, and your next action waits for the hand-back.",
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
            "drag",
            "back",
            "forward",
            "reload",
            "read",
            "eval",
            "wait",
            "wait_for",
            "tab_new",
            "tab_switch",
            "tab_close",
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
        x: { type: "number", description: "click: page coordinate fallback (use with y)" },
        y: { type: "number", description: "click: page coordinate fallback (use with x)" },
        to_index: { type: "number", description: "drag: destination element number" },
        to_selector: { type: "string", description: "drag: destination CSS selector" },
        state: {
          type: "string",
          enum: ["visible", "hidden", "attached", "detached"],
          description: "wait_for: the state to wait for (default visible)",
        },
        timeout_ms: { type: "number", description: "wait_for: how long to wait (default 10000)" },
        screenshot: { type: "boolean", description: "set false to skip the screenshot image" },
        path: {
          type: "string",
          description: "upload: file path (relative to the working directory)",
        },
      },
      required: ["action"],
    },
  },
  async run(input, ctx) {
    // One isolated context per task (own profile, own downloads, hard limits) — so this is safe on a
    // multi-user server as well as on a laptop. Downloads belong to the task's workspace.
    const s = browserSession(ctx.sessionId);
    s.useWorkspace(ctx.cwd);
    // If the user has taken the browser over (login, 2FA, captcha) or paused it, wait for the hand-back.
    if (await waitWhileTaken(s, ctx.signal))
      return { content: "[paused: the user has the browser] Wait, or do other work meanwhile.", isError: false };
    const p = await s.page();
    try {
      return await act(s, p, input, ctx.cwd);
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      // Show the model where things stand instead of a bare stack, so it can pick another element.
      const msg = String((e as Error).message ?? e)
        .split("\n")[0]
        .replace(/^locator\.\w+: /, "");
      const out = await observe(s, p, `Action ${String(input.action)} failed: ${msg}`, false, input.screenshot !== false).catch(() => ({
        content: `Action ${String(input.action)} failed: ${msg}`,
      }));
      return { ...out, isError: true };
    }
  },
};

/** Retry once when an element goes stale mid-action (the page re-rendered under us). */
const STALE = /stale|not attached|detached|intercepts pointer|element is not visible|waiting for (locator|element)/i;
async function once<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!STALE.test(String((e as Error)?.message ?? e))) throw e;
    return fn();
  }
}

/** Point the live viewer's cursor at what the agent is about to touch, so the user can follow. */
async function point(s: BrowserSession, p: Page, input: Record<string, unknown>, label: string) {
  try {
    const b = await target(p, input).boundingBox({ timeout: 1500 });
    if (b) s.pointer = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), label };
  } catch {}
}

async function act(s: BrowserSession, p0: Page, input: Record<string, unknown>, cwd: string) {
  let p = p0;
  const a = String(input.action);
  const T = { timeout: 15_000 };
  const shot = input.screenshot !== false;
  const obs = (page: Page, note: string, full = false) => observe(s, page, note, full, shot);
  switch (a) {
    case "goto": {
      let url = String(input.url);
      if (!/^[a-z]+:/i.test(url)) url = "https://" + url;
      try {
        const r = await p.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        return obs(p, `Navigated (${r?.status() ?? "?"}).`);
      } catch (e) {
        // Direct links to files (PDF, zip, csv…) start a download instead of a page load.
        if (/Download is starting|net::ERR_ABORTED/.test(String((e as Error).message)))
          return obs(p, `${url} is a file; downloading it.`);
        throw e;
      }
    }
    case "upload": {
      const file = path.resolve(cwd, String(input.path ?? ""));
      if (!input.path || !fs.existsSync(file))
        return { content: `No file at ${file}.`, isError: true };
      const t = target(p, input);
      await point(s, p, input, `upload ${path.basename(file)}`);
      try {
        await once(() => t.setInputFiles(file, { timeout: 5_000 }));
      } catch {
        // Not an <input type=file>: click it and answer the file chooser it opens.
        const [chooser] = await Promise.all([p.waitForEvent("filechooser", T), once(() => t.click(T))]);
        await chooser.setFiles(file);
      }
      return obs(p, `Attached ${path.basename(file)}.`);
    }
    case "click": {
      // Screenshot fallback: with no element target, x/y in page coordinates still clicks.
      if (input.index == null && !input.selector && input.text == null && typeof input.x === "number" && typeof input.y === "number") {
        s.pointer = { x: input.x, y: input.y, label: "click" };
        await p.mouse.click(input.x, input.y);
        return obs(p, "Clicked at coordinates.");
      }
      await point(s, p, input, String(input.selector ?? (input.index != null ? `[${input.index}]` : `"${String(input.text ?? "")}"`)));
      await once(() => target(p, input).click(T));
      return obs(p, "Clicked.");
    }
    case "type": {
      const t = target(p, input);
      await point(s, p, input, "type here");
      await once(() =>
        t.fill(String(input.text ?? input.value ?? ""), T).catch(async () => {
          await t.click(T);
          await p.keyboard.type(String(input.text ?? input.value ?? ""));
        }),
      );
      if (input.submit) await p.keyboard.press("Enter");
      return obs(p, "Typed.");
    }
    case "press":
      await p.keyboard.press(String(input.key));
      return obs(p, `Pressed ${input.key}.`);
    case "scroll":
      await p.mouse.wheel(0, Number(input.dy ?? 700));
      return obs(p, "Scrolled.");
    case "select":
      await point(s, p, input, "select");
      await once(() => target(p, input).selectOption(String(input.value), T));
      return obs(p, "Selected.");
    case "hover":
      await point(s, p, input, String(input.selector ?? `[${input.index ?? ""}]`));
      await once(() => target(p, input).hover(T));
      return obs(p, "Hovered.");
    case "drag": {
      const from = target(p, input);
      const to = target(p, { index: input.to_index, selector: input.to_selector, text: undefined });
      await point(s, p, input, "drag from");
      const box = await from.boundingBox(T).catch(() => null);
      if (box) s.pointer = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), label: "drag" };
      await once(() =>
        from.dragTo(to, { timeout: 15_000 }).catch(async () => {
          // Dragging an element the browser won't release: fall back to raw mouse moves.
          const a1 = await from.boundingBox(T);
          const b1 = await to.boundingBox(T);
          if (!a1 || !b1) throw new Error("Drag source or destination is not visible.");
          await p.mouse.move(a1.x + a1.width / 2, a1.y + a1.height / 2);
          await p.mouse.down();
          await p.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2, { steps: 12 });
          await p.mouse.up();
        }),
      );
      s.pointer = null;
      return obs(p, "Dragged.");
    }
    case "back":
      await p.goBack();
      return obs(p, "Back.");
    case "forward":
      await p.goForward();
      return obs(p, "Forward.");
    case "reload":
      await p.reload();
      return obs(p, "Reloaded.");
    case "read":
      return obs(p, "Page contents:", true);
    case "eval": {
      const v = await p.evaluate(String(input.js));
      return {
        content: clip(typeof v === "string" ? v : (JSON.stringify(v, null, 2) ?? "undefined"), 40_000),
      };
    }
    case "wait": {
      await p.waitForTimeout(Math.min(60_000, Number(input.ms ?? 1500)));
      return obs(p, "Waited.");
    }
    case "wait_for": {
      // "Something appears" without guessing: waits for an element (or the text) to reach a state.
      const timeout = Math.min(60_000, Number(input.timeout_ms ?? 10_000));
      const state = String(input.state ?? "visible") as "visible" | "hidden" | "attached" | "detached";
      const how = input.selector ? p.locator(String(input.selector)) : p.getByText(String(input.text ?? ""), { exact: false });
      await how.first().waitFor({ state, timeout });
      return obs(p, `Found it (${state}).`);
    }
    case "tab_new":
      p = await s.newPage(typeof input.url === "string" ? String(input.url) : undefined);
      return obs(p, "Opened tab.");
    case "tab_switch":
      p = await s.switchTab(Number(input.tab));
      return obs(p, "Switched tab.");
    case "tab_close":
      await s.closeTab(input.tab != null ? Number(input.tab) : undefined);
      p = await s.page();
      return obs(p, "Closed tab.");
    case "screenshot":
      return obs(p, "Screenshot.");
    default:
      return obs(p, "Current page.");
  }
}
