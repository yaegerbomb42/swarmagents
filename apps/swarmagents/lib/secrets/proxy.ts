/**
 * Outbound vault proxy. The VM supplies a destination; the host injects the
 * real credential only after the token, secret id, and allowlist all match.
 */

import { createHash, createHmac } from "node:crypto";
import { recordAudit } from "../audit";
import { hostAllowed, HTTP_KINDS, type SecretKind } from "./allowlist";
import { openSecret, parseAwsMaterial } from "./registry";
import { verifyVaultToken } from "./token";

const MAX_BODY = 1024 * 1024;

export interface ProxyRequest {
  token: string;
  secretId: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ProxyResult {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: "manual" }) => Promise<{
  status: number;
  text: () => Promise<string>;
  headers: { get(name: string): string | null };
}>;

function audit(user: string, target: string, result: "success" | "failure"): void {
  recordAudit({ user, action: "vault.proxy", target, result });
}

function reject(status: number, error: string, user = "anonymous", target = "vault"): ProxyResult {
  if (user !== "anonymous") audit(user, target, "failure");
  return { status, body: JSON.stringify({ error }), headers: { "content-type": "application/json" } };
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function awsRegion(host: string, fallback: string): string {
  const parts = host.split(".");
  // service.region.amazonaws.com or service.amazonaws.com
  if (parts.length >= 4 && parts[parts.length - 2] !== "amazonaws") return parts[parts.length - 3];
  return fallback;
}

function awsService(host: string): string {
  return host.split(".")[0] || "execute-api";
}

export function signAws(
  material: { accessKeyId: string; secretAccessKey: string; region?: string },
  method: string,
  url: URL,
  body: string,
  now = new Date(),
): Record<string, string> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const region = material.region || awsRegion(url.hostname, "us-east-1");
  const service = awsService(url.hostname);
  const payloadHash = sha256Hex(body);
  const canonicalHeaders = `host:${url.hostname}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonical = [
    method.toUpperCase(),
    url.pathname || "/",
    url.search.slice(1),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(canonical)}`;
  const kDate = hmac(`AWS4${material.secretAccessKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return {
    host: url.hostname,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    authorization: `AWS4-HMAC-SHA256 Credential=${material.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function injectHeaders(kind: SecretKind, plaintext: string, url: URL, method: string, body: string): Record<string, string> {
  if (kind === "aws") {
    return signAws(parseAwsMaterial(plaintext), method, url, body);
  }
  if (kind === "github") {
    return {
      authorization: `Bearer ${plaintext}`,
      accept: "application/vnd.github+json",
    };
  }
  return { authorization: `Bearer ${plaintext}` };
}

export async function proxyVaultRequest(
  req: ProxyRequest,
  options: { fetchImpl?: FetchFn; env?: Record<string, string | undefined>; now?: number } = {},
): Promise<ProxyResult> {
  const caller = verifyVaultToken(req.token, { env: options.env, now: options.now });
  if (!caller) return reject(401, "Vault token is missing, expired, or revoked.");
  const targetBase = req.secretId.slice(0, 64);
  if (!caller.secretIds.includes(req.secretId)) {
    return reject(403, "Token is not scoped to this secret.", caller.userId, targetBase);
  }
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return reject(400, "Destination URL is invalid.", caller.userId, targetBase);
  }
  if (url.username || url.password) {
    return reject(400, "Destination URL must not carry credentials.", caller.userId, url.hostname);
  }
  if (url.protocol !== "https:") {
    return reject(400, "Destination must be https.", caller.userId, url.hostname);
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.includes(":")) {
    return reject(400, "IP literals are not allowlisted destinations.", caller.userId, "ip");
  }
  const opened = openSecret(caller.userId, req.secretId, options.env);
  if (!opened) return reject(404, "Unknown secret.", caller.userId, targetBase);
  const auditTarget = `${opened.kind}:${req.secretId}:${url.hostname}`.slice(0, 128);
  if (!(HTTP_KINDS as readonly string[]).includes(opened.kind)) {
    return reject(403, "Database secrets are not injected over HTTP.", caller.userId, auditTarget);
  }
  if (!hostAllowed(opened.kind, url.hostname)) {
    return reject(403, "Destination is not allowlisted for this secret.", caller.userId, auditTarget);
  }
  const method = (req.method || "GET").toUpperCase();
  if (!/^[A-Z]+$/.test(method) || method.length > 10) {
    return reject(400, "Bad method.", caller.userId, auditTarget);
  }
  const body = req.body ?? "";
  if (body.length > MAX_BODY) return reject(413, "Body too large.", caller.userId, auditTarget);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower === "authorization" || lower === "cookie" || lower === "host" || lower === "proxy-authorization") {
      continue;
    }
    if (typeof value === "string" && value.length < 4096) headers[lower] = value;
  }
  Object.assign(headers, injectHeaders(opened.kind, opened.plaintext, url, method, body));

  const fetchImpl = options.fetchImpl ?? ((u, init) => fetch(u, init));
  let upstream: { status: number; text: () => Promise<string>; headers: { get(name: string): string | null } };
  try {
    upstream = await fetchImpl(url.toString(), {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
      redirect: "manual",
    });
  } catch {
    return reject(502, "Upstream connection failed.", caller.userId, auditTarget);
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    return reject(502, "Redirects are not followed.", caller.userId, auditTarget);
  }
  const text = await upstream.text();
  audit(caller.userId, auditTarget, upstream.status >= 200 && upstream.status < 300 ? "success" : "failure");
  const contentType = upstream.headers.get("content-type") || "application/octet-stream";
  return {
    status: upstream.status,
    body: text.slice(0, MAX_BODY),
    headers: { "content-type": contentType },
  };
}
