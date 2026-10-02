import fs from "node:fs";
import path from "node:path";
import { searchKeys } from "../connections";
import { getSearchConfig } from "../store";
import { clip, type Tool } from "./types";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

export function htmlToText(html: string) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\s[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, h, t) => `${t.replace(/<[^>]+>/g, "").trim()} (${h})`)
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<h(\d)[^>]*>/gi, (_, n) => "\n" + "#".repeat(+n) + " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export const webSearch: Tool = {
  spec: {
    name: "web_search",
    description: "Search the web. Returns titles, URLs and snippets. Follow up with web_fetch or the browser.",
    schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  async run(input, ctx) {
    // Search APIs from Settings → Tool keys (Brave, Tavily, Exa, Serper), then the legacy
    // settings.json/env Tavily key; each failure falls through, DuckDuckGo scraping is the last resort.
    const query = String(input.query);
    const errors: string[] = [];
    for (const { service, key } of searchProviders()) {
      try {
        const out = formatHits(await SEARCHERS[service](query, key, ctx.signal), service);
        if (out) return { content: out };
        errors.push(`${service}: no results`);
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    const ddg = await duckScrape(query, ctx.signal);
    return errors.length ? { content: `${ddg.content}

(Search APIs failed, used DuckDuckGo: ${errors.join("; ")})` } : ddg;
  },
};

type Hit = { title: string; url: string; snippet: string };
type Searcher = (q: string, key: string, signal: AbortSignal) => Promise<Hit[]>;

/** Test hook: point every search provider at one mock server (`${SWARM_SEARCH_MOCK}/<service>`). */
const endpoint = (service: string, real: string) => (process.env.SWARM_SEARCH_MOCK ? `${process.env.SWARM_SEARCH_MOCK.replace(/\/$/, "")}/${service}` : real);

async function getJson(res: Response, service: string) {
  if (!res.ok) throw new Error(`${service} ${res.status}${res.status === 401 || res.status === 403 ? " (check the key in Settings)" : res.status === 429 ? " (rate limited)" : ""}`);
  return res.json();
}

const SEARCHERS: Record<string, Searcher> = {
  async brave(q, key, signal) {
    const res = await fetch(`${endpoint("brave", "https://api.search.brave.com/res/v1/web/search")}?${new URLSearchParams({ q, count: "10" })}`, {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
      signal,
    });
    const d = (await getJson(res, "brave")) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return (d.web?.results ?? []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.description ?? "" }));
  },
  async tavily(q, key, signal) {
    const res = await fetch(endpoint("tavily", "https://api.tavily.com/search"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: q, max_results: 10, search_depth: "basic", include_answer: false }),
      signal,
    });
    const d = (await getJson(res, "tavily")) as { results?: { title?: string; url?: string; content?: string }[] };
    return (d.results ?? []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.content ?? "" }));
  },
  async exa(q, key, signal) {
    const res = await fetch(endpoint("exa", "https://api.exa.ai/search"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify({ query: q, numResults: 10, contents: { text: { maxCharacters: 500 } } }),
      signal,
    });
    const d = (await getJson(res, "exa")) as { results?: { title?: string; url?: string; text?: string; summary?: string }[] };
    return (d.results ?? []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.summary ?? r.text ?? "" }));
  },
  async serper(q, key, signal) {
    const res = await fetch(endpoint("serper", "https://google.serper.dev/search"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": key },
      body: JSON.stringify({ q, num: 10 }),
      signal,
    });
    const d = (await getJson(res, "serper")) as { organic?: { title?: string; link?: string; snippet?: string }[] };
    return (d.organic ?? []).map((r) => ({ title: r.title ?? "", url: r.link ?? "", snippet: r.snippet ?? "" }));
  },
};

function formatHits(hits: Hit[], via: string) {
  const lines = hits.slice(0, 10).map((r, i) => `${i + 1}. ${r.title || r.url}\n   ${r.url}\n   ${r.snippet.replace(/\s+/g, " ").slice(0, 500)}`);
  return lines.length ? `${lines.join("\n\n")}\n\n(via ${via})` : "";
}

/** Keys from Settings → Tool keys first (in catalog order), then the legacy settings.json/env Tavily key. */
function searchProviders(): { service: string; key: string }[] {
  const list = searchKeys().filter((k) => SEARCHERS[k.service]);
  const legacy = getSearchConfig();
  if (legacy?.apiKey && SEARCHERS[legacy.provider] && !list.some((k) => k.service === legacy.provider && k.key === legacy.apiKey)) {
    list.push({ service: legacy.provider, key: legacy.apiKey });
  }
  return list;
}

async function duckScrape(query: string, signal: AbortSignal) {
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ q: query }),
      signal,
    });
    const html = await res.text();
    const results: string[] = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    for (const m of html.matchAll(re)) {
      let url = m[1];
      const u = url.match(/uddg=([^&]+)/);
      if (u) url = decodeURIComponent(u[1]);
      results.push(`${results.length + 1}. ${htmlToText(m[2])}\n   ${url}\n   ${htmlToText(m[3])}`);
      if (results.length >= 10) break;
    }
    return { content: results.join("\n\n") || "No results (search may be blocked; try the browser tool with a search engine)." };
}

const MODEL_IMAGES = /^image\/(png|jpeg|gif|webp)$/;
const TEXTISH = /^text\/|json|xml|javascript|ecmascript|svg|x-www-form-urlencoded|yaml|csv|graphql/i;
const MAX_INLINE_IMAGE = 3_500_000;

/** Save a binary response under <cwd>/downloads (name from Content-Disposition or the URL). */
function saveDownload(cwd: string, res: Response, buf: Buffer) {
  const cd = res.headers.get("content-disposition") ?? "";
  const fromHeader = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1] ?? /filename="?([^";]+)"?/i.exec(cd)?.[1];
  let name = "";
  try {
    name = decodeURIComponent(fromHeader ?? path.basename(new URL(res.url).pathname));
  } catch {
    name = fromHeader ?? "";
  }
  name = (name || "download").replace(/[/\\:\0]/g, "_").slice(0, 150);
  const dir = path.join(cwd, "downloads");
  fs.mkdirSync(dir, { recursive: true });
  const dot = name.lastIndexOf(".") > 0 ? name.lastIndexOf(".") : name.length;
  let file = path.join(dir, name);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${name.slice(0, dot)} (${i})${name.slice(dot)}`);
  fs.writeFileSync(file, buf);
  return file;
}

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

export const webFetch: Tool = {
  spec: {
    name: "web_fetch",
    description:
      "Fetch a URL and return readable text (HTML converted). Images come back as images; PDFs, archives, audio and other files are saved under ./downloads and the path is returned. Use the browser tool for JS-heavy pages, logins or interaction.",
    schema: { type: "object", properties: { url: { type: "string" }, raw: { type: "boolean", description: "Return raw body" } }, required: ["url"] },
  },
  async run(input, ctx) {
    let res: Response;
    try {
      res = await fetch(String(input.url), {
        headers: { "User-Agent": UA, Accept: "text/html,application/json,*/*" },
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(60_000)]),
        redirect: "follow",
      });
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      const err = e as Error & { cause?: { code?: string; message?: string } };
      const why = err.cause?.code ?? err.cause?.message ?? err.message;
      return { content: err.name === "TimeoutError" ? `${input.url} didn't answer within 60s.` : `Couldn't fetch ${input.url}: ${why}`, isError: true };
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const head = `[${res.status}] ${res.url}`;
    if (!TEXTISH.test(type) && type && !/html/.test(type)) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (MODEL_IMAGES.test(type) && buf.length <= MAX_INLINE_IMAGE) return { content: `${head}\nImage (${type}, ${fmtSize(buf.length)})`, images: [{ mediaType: type, data: buf.toString("base64") }], isError: !res.ok };
      const file = saveDownload(ctx.cwd, res, buf);
      const hint = type === "application/pdf" ? " To read it: open it with the browser tool (file:// URL), or extract text with `pdftotext` / python if available." : "";
      return { content: `${head}\nSaved ${fmtSize(buf.length)} (${type || "unknown type"}) to ${file}.${hint}`, isError: !res.ok };
    }
    const body = await res.text();
    const text = input.raw || !/html/.test(type) ? body : htmlToText(body);
    return { content: clip(`${head}\n\n${text}`, 50_000), isError: !res.ok };
  },
};
