import fs from "node:fs";
import path from "node:path";
import { getToolKey } from "../connections";
import { TOOL_PRESETS, apiAccess, fillTemplate, type ToolPreset } from "../presets";
import { clip, type Tool } from "./types";
import { assertInsideHome } from "../sandbox";
import { noteWrite, storageBlock } from "../tenant/storage";

// api_request: call a service's HTTP API with the user's saved key (Settings → Tool keys) without the agent
// ever seeing it. The key goes only to that service's own hosts, so injected instructions can't redirect it.
// Binary answers (audio, images, archives) are saved to <cwd>/downloads.

const TIMEOUT_MS = 120_000;
const MAX_BODY = 30_000;

/** Test hook: lets e2e point every service at a local mock (the operator sets this; the agent can't). */
const mockHost = () => (process.env.SWARM_API_MOCK ? new URL(process.env.SWARM_API_MOCK).host : null);

function usable(): { preset: ToolPreset; key: string; access: NonNullable<ReturnType<typeof apiAccess>> }[] {
  return TOOL_PRESETS.flatMap((preset) => {
    const access = apiAccess(preset);
    const key = access ? getToolKey(preset.id) : undefined;
    return access && key ? [{ preset, key, access }] : [];
  });
}

const listServices = () =>
  usable()
    .map(({ preset, access }) => `- ${preset.id} (${preset.label}): ${access.hosts.join(", ")}${access.docs ? ` — ${access.docs}` : ""}`)
    .join("\n");

const isText = (type: string) => /^text\/|json|xml|javascript|x-www-form-urlencoded|graphql|yaml|csv/i.test(type);

const EXT: Record<string, string> = { "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf", "application/zip": "zip", "video/mp4": "mp4" };

export const apiRequest: Tool = {
  spec: {
    name: "api_request",
    description:
      "Call a service's HTTP API using the user's saved key for it (Settings → Tool keys). You never see the key: it's added server-side and only sent to that service's own hosts. Pass `service` (the key's id), `url` (absolute, or a path on the service's first host), optional method/query/headers/body. JSON and text responses come back inline; binary ones (audio, images, files) are saved under ./downloads. Call with service \"list\" to see which services have keys.",
    schema: {
      type: "object",
      properties: {
        service: { type: "string", description: 'Tool key id, e.g. "github-token", "replicate", "elevenlabs", or "list"' },
        url: { type: "string" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        query: { type: "object", description: "Query parameters" },
        headers: { type: "object", description: "Extra headers (auth headers are set for you)" },
        body: { description: "JSON body (object) or raw string" },
        save_as: { type: "string", description: "File name for a binary response" },
      },
      required: ["service"],
    },
  },
  async run(input, ctx) {
    const service = String(input.service ?? "");
    const all = usable();
    const hit = all.find((u) => u.preset.id === service);
    if (!hit) {
      const list = listServices();
      return {
        content: list
          ? `${service && service !== "list" ? `No saved key for "${service}". ` : ""}Services with keys:\n${list}`
          : "No API keys are saved yet. The user can add them in Settings → Tool keys.",
        isError: !!service && service !== "list",
      };
    }
    const { preset, key, access } = hit;
    let url: URL;
    try {
      const raw = String(input.url ?? "");
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${access.hosts[0]}/${raw.replace(/^\/+/, "")}`);
    } catch {
      return { content: `Invalid url: ${String(input.url)}`, isError: true };
    }
    const mock = mockHost();
    if (!(access.hosts.includes(url.host) || (mock && url.host === mock))) {
      return { content: `The ${preset.label} key is only sent to ${access.hosts.join(", ")}; ${url.host} isn't one of them. Use web_fetch for other URLs.`, isError: true };
    }
    if (url.protocol !== "https:" && !(mock && url.host === mock)) return { content: "Keys are only sent over https.", isError: true };

    for (const [k, v] of Object.entries((input.query as Record<string, unknown>) ?? {})) url.searchParams.set(k, String(v));
    for (const [k, v] of Object.entries(access.query)) url.searchParams.set(k, fillTemplate(v, { key }));

    const authNames = new Set(Object.keys(access.headers).map((h) => h.toLowerCase()));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((input.headers as Record<string, unknown>) ?? {})) {
      // The agent can add headers but never replace or spoof the credential ones.
      if (!authNames.has(k.toLowerCase()) && !/^(authorization|x-api-key|api-key|cookie)$/i.test(k)) headers[k] = String(v);
    }
    for (const [k, v] of Object.entries(access.headers)) headers[k] = fillTemplate(v, { key });
    const method = String(input.method ?? (input.body !== undefined ? "POST" : "GET")).toUpperCase();
    let body: string | undefined;
    if (input.body !== undefined && method !== "GET") {
      body = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["Content-Type"] = typeof input.body === "string" ? "text/plain" : "application/json";
    }

    const redact = (s: string) => (key.length >= 6 ? s.split(key).join("[key]") : s);
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]) });
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      const err = e as Error;
      return { content: err.name === "TimeoutError" ? `${preset.label} didn't answer within ${TIMEOUT_MS / 1000}s.` : `Request failed: ${redact(err.message)}`, isError: true };
    }
    const type = res.headers.get("content-type") ?? "";
    const shown = url.toString().split(key).join("[key]");
    const head = `${method} ${shown}\nHTTP ${res.status} ${res.statusText}${type ? ` · ${type.split(";")[0]}` : ""}`;
    if (res.status >= 300 && res.status < 400) {
      // Never follow with the key attached; the target is usually a public file/CDN URL.
      return { content: `${head}\nRedirects to: ${res.headers.get("location") ?? "?"} (fetch it with web_fetch; the key isn't sent there).` };
    }
    if (!isText(type) && res.ok && type) {
      const buf = Buffer.from(await res.arrayBuffer());
      // Per-user storage quota: refuse before writing, so a full account never ends up with a partial file.
      const full = storageBlock(buf.length);
      if (full) return { content: `${head}\nNot saved (${buf.length} bytes): ${full.message}`, isError: true };
      const dir = assertInsideHome(path.join(ctx.cwd, "downloads"));
      fs.mkdirSync(dir, { recursive: true });
      const base = (String(input.save_as ?? "") || path.basename(url.pathname) || preset.id).replace(/[/\\:\0]/g, "_").slice(0, 120);
      const ext = EXT[type.split(";")[0]];
      const name = ext && !base.toLowerCase().endsWith(`.${ext}`) ? `${base}.${ext}` : base;
      const dot = name.lastIndexOf(".") > 0 ? name.lastIndexOf(".") : name.length;
      let file = path.join(dir, name);
      for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${name.slice(0, dot)} (${i})${name.slice(dot)}`);
      fs.writeFileSync(file, buf);
      noteWrite(buf.length);
      return { content: `${head}\nSaved ${buf.length} bytes to ${file}` };
    }
    const text = redact(await res.text());
    let pretty = text;
    if (/json/i.test(type)) {
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 1);
      } catch {}
    }
    return { content: clip(`${head}\n\n${pretty}`, MAX_BODY), isError: res.status >= 400 };
  },
};
