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
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ q: String(input.query) }),
      signal: ctx.signal,
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
  },
};

export const webFetch: Tool = {
  spec: {
    name: "web_fetch",
    description: "Fetch a URL and return readable text (HTML converted). Use the browser tool for JS-heavy pages, logins or interaction.",
    schema: { type: "object", properties: { url: { type: "string" }, raw: { type: "boolean", description: "Return raw body" } }, required: ["url"] },
  },
  async run(input, ctx) {
    const res = await fetch(String(input.url), { headers: { "User-Agent": UA, Accept: "text/html,application/json,*/*" }, signal: ctx.signal, redirect: "follow" });
    const type = res.headers.get("content-type") ?? "";
    if (/image\//.test(type)) {
      const buf = Buffer.from(await res.arrayBuffer());
      return { content: `Image from ${res.url}`, images: [{ mediaType: type.split(";")[0], data: buf.toString("base64") }] };
    }
    const body = await res.text();
    const text = input.raw || !/html/.test(type) ? body : htmlToText(body);
    return { content: clip(`[${res.status}] ${res.url}\n\n${text}`, 50_000), isError: !res.ok };
  },
};
