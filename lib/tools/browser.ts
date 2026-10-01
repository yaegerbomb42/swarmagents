import { chromium, type BrowserContext, type Page } from "playwright-core";
import { BROWSER_PROFILE } from "../store";
import { clip, type Tool } from "./types";

// One persistent, visible Chrome for the whole app: the user can watch it, and logins stick between tasks.
let ctxP: Promise<BrowserContext> | null = null;
let current: Page | null = null;

async function context() {
  if (!ctxP) {
    ctxP = chromium
      .launchPersistentContext(BROWSER_PROFILE, { channel: "chrome", headless: false, viewport: null, args: ["--window-size=1280,900"] })
      .catch(() => chromium.launchPersistentContext(BROWSER_PROFILE, { headless: false, viewport: { width: 1280, height: 860 } }));
    const c = await ctxP.catch((e) => {
      ctxP = null;
      throw e;
    });
    c.on("close", () => ((ctxP = null), (current = null)));
    c.on("page", (p) => (current = p));
  }
  return ctxP;
}

async function page() {
  const c = await context();
  if (!current || current.isClosed()) current = c.pages().find((p) => !p.isClosed()) ?? (await c.newPage());
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

async function observe(p: Page, note: string, full = false) {
  await p.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
  await p.waitForTimeout(400);
  const snap = (await p.evaluate(SNAPSHOT).catch(() => ({ title: "", url: p.url(), elements: "", text: "" }))) as Record<string, string>;
  const shot = await p.screenshot({ type: "jpeg", quality: 60 }).catch(() => null);
  const tabs = p.context().pages();
  return {
    content: clip(
      `${note}\nTab ${tabs.indexOf(p) + 1}/${tabs.length}: ${snap.title}\n${snap.url}\n\nInteractive elements:\n${snap.elements || "(none)"}${full ? `\n\nPage text:\n${snap.text}` : ""}`,
      40_000,
    ),
    images: shot ? [{ mediaType: "image/jpeg", data: shot.toString("base64") }] : undefined,
  };
}

const target = (p: Page, input: Record<string, unknown>) =>
  input.index != null ? p.locator(`[data-swarm-id="${input.index}"]`).first() : input.selector ? p.locator(String(input.selector)).first() : p.getByText(String(input.text), { exact: false }).first();

export const browser: Tool = {
  spec: {
    name: "browser",
    description:
      "Control a real Chrome window (visible to the user, persistent logins). Every action returns a screenshot plus numbered interactive elements; target elements by `index` from the latest observation (or `selector` / `text`). Actions: goto(url), click, type(text, submit?), press(key), scroll(dy), select(value), hover, back, forward, reload, read (full page text), eval(js), tab_new(url?), tab_switch(tab), tab_close, wait(ms), screenshot.",
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["goto", "click", "type", "press", "scroll", "select", "hover", "back", "forward", "reload", "read", "eval", "tab_new", "tab_switch", "tab_close", "wait", "screenshot"],
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
      },
      required: ["action"],
    },
  },
  async run(input) {
    const a = String(input.action);
    let p = await page();
    const T = { timeout: 15_000 };
    switch (a) {
      case "goto": {
        let url = String(input.url);
        if (!/^[a-z]+:/i.test(url)) url = "https://" + url;
        const r = await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        return observe(p, `Navigated (${r?.status() ?? "?"}).`);
      }
      case "click":
        await target(p, input).click(T);
        return observe(p, "Clicked.");
      case "type": {
        const t = target(p, input);
        await t.fill(String(input.text ?? input.value ?? ""), T).catch(async () => {
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
        return { content: clip(typeof v === "string" ? v : JSON.stringify(v, null, 2) ?? "undefined", 40_000) };
      }
      case "tab_new":
        current = p = await p.context().newPage();
        if (input.url) await p.goto(String(input.url), { waitUntil: "domcontentloaded" });
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
  },
};
