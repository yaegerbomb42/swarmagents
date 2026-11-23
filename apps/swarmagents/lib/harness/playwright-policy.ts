import { createHash } from "node:crypto";

/** Network endpoint shared by Playwright MCP processes inside one VM. */
export const PLAYWRIGHT_PROXY_ORIGIN = "http://127.0.0.1:18793";
export const PLAYWRIGHT_PROXY_PATH = "/workspace/.swarm/playwright-proxy.cjs";
export const PLAYWRIGHT_LAUNCHER_PATH = "/workspace/.swarm/playwright-mcp-launcher.cjs";

/** Path of the Playwright MCP per-page request guard inside the VM. */
export const PLAYWRIGHT_POLICY_PATH = "/workspace/.swarm/playwright-policy.cjs";

/**
 * Request guard loaded by Playwright MCP's --init-page hook for every tab.
 * Defense in depth alongside the shared loopback HTTP/CONNECT proxy below.
 * The proxy covers subresources and redirect hops even where Playwright's
 * route API does not re-enter its handler. Explicit loopback is allowed for
 * the VM's own dev-server previews;
 * every other private/reserved destination (including DNS results) is aborted.
 */
export const PLAYWRIGHT_POLICY_SOURCE = String.raw`// SwarmAgents Playwright MCP request guard (CommonJS).
const dns = require("node:dns").promises;
const net = require("node:net");

function normalize(host) {
  return String(host || "").trim().toLowerCase().replace(/\.+$/, "");
}
function bareIpv6(host) {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}
function ipv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const out = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}
function expandIpv6(host) {
  // Strip any IPv6 zone ID (fe80::1%eth0): zones never affect the address.
  let h = bareIpv6(host).toLowerCase().split("%")[0];
  const trailing4 = /^(.*):(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (trailing4) {
    const parts = trailing4[2].split(".").map(Number);
    if (parts.some((n) => n > 255)) return null;
    h = trailing4[1] + ":" + (((parts[0] << 8) | parts[1]).toString(16)) + ":" + (((parts[2] << 8) | parts[3]).toString(16));
  }
  if (!/^[0-9a-f:]+$/.test(h)) return null;
  let groups;
  const double = h.indexOf("::");
  if (double !== -1) {
    const left = h.slice(0, double).split(":").filter(Boolean).map((g) => parseInt(g, 16));
    const right = h.slice(double + 2).split(":").filter(Boolean).map((g) => parseInt(g, 16));
    if (left.length + right.length >= 8) return null;
    groups = left.concat(new Array(8 - left.length - right.length).fill(0), right);
  } else {
    groups = h.split(":").map((g) => parseInt(g, 16));
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isFinite(g) || g < 0 || g > 65535)) return null;
  return groups;
}
function privateIpv4(host) {
  const p = ipv4(host);
  if (!p) return false;
  return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 192 && p[1] === 0 && p[2] === 0) ||
    (p[0] === 198 && p[1] >= 18 && p[1] <= 19) ||
    p[0] >= 224;
}
function privateIpv6(host) {
  const g = expandIpv6(host);
  // Fail closed: an unparseable IPv6 literal is treated as private/blocked.
  if (!g) return true;
  if (g.every((n) => n === 0)) return true;
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true;
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  if ((g[0] & 0xffc0) === 0xfec0) return true;
  if ((g[0] & 0xff00) === 0xff00) return true;
  if (g[0] === 0x2002) return true;
  if (g[0] === 0x2001 && g[1] === 0) return true;
  if (g[0] === 0x64 && g[1] === 0xff9b) return true;
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    return privateIpv4(((g[6] >> 8) & 255) + "." + (g[6] & 255) + "." + ((g[7] >> 8) & 255) + "." + (g[7] & 255));
  }
  if (g.slice(0, 6).every((n) => n === 0)) {
    return privateIpv4(((g[6] >> 8) & 255) + "." + (g[6] & 255) + "." + ((g[7] >> 8) & 255) + "." + (g[7] & 255));
  }
  return false;
}
function privateIp(host) {
  const bare = bareIpv6(normalize(host));
  return bare.includes(":") ? privateIpv6(bare) : privateIpv4(bare);
}
function loopback(host) {
  const h = bareIpv6(normalize(host));
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.includes(":")) {
    const g = expandIpv6(h);
    return g !== null && g.slice(0, 7).every((n) => n === 0) && g[7] === 1;
  }
  const p = ipv4(h);
  return p !== null && p[0] === 127;
}
function privateHostname(host) {
  const h = normalize(host);
  if (h === "metadata.google.internal") return true;
  for (const suffix of [".local", ".internal", ".localdomain"]) {
    if (h === suffix.slice(1) || h.endsWith(suffix)) return true;
  }
  return false;
}
async function blocked(raw) {
  return (await resolveTarget(raw)).reason;
}
// Resolve once and keep the validated addresses with the verdict, so the
// proxy can connect to the very IP that was checked. Resolving a second time
// at connect time would let a changed DNS answer swap in a private address
// (DNS rebinding) after the policy check passed.
async function resolveTarget(raw) {
  let url;
  try { url = new URL(raw); } catch { return { reason: "malformed URL", addresses: [] }; }
  // Only HTTP(S) is ever proxied: every other scheme is denied outright
  // instead of falling through as allowed.
  if (url.protocol !== "http:" && url.protocol !== "https:") return { reason: "blocked protocol", addresses: [] };
  const host = bareIpv6(url.hostname);
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (loopback(host)) {
    // Never let a rogue resolver answer for localhost: pin it to loopback,
    // except the proxy's own port, which would loop back into the proxy.
    if (port === 18793) return { reason: "self-proxy loopback target", addresses: [] };
    const address = host === "localhost" || host.endsWith(".localhost")
      ? "127.0.0.1"
      : host;
    return { reason: null, addresses: [{ address, family: address.includes(":") ? 6 : 4 }] };
  }
  if (privateHostname(host) || privateIp(host)) return { reason: host, addresses: [] };
  if (net.isIP(host) !== 0) return { reason: null, addresses: [{ address: host, family: net.isIP(host) }] };
  let records;
  try { records = await dns.lookup(normalize(host), { all: true }); } catch { return { reason: "DNS lookup failed", addresses: [] }; }
  if (!records.length) return { reason: "DNS lookup returned no addresses", addresses: [] };
  const blockedAddress = records.find((record) => privateIp(record.address));
  if (blockedAddress) return { reason: blockedAddress.address, addresses: [] };
  return { reason: null, addresses: records };
}

exports.default = async ({ page }) => {
  await page.route("**/*", async (route, request) => {
    let reason;
    try { reason = await blocked(request.url()); } catch { reason = "policy check failed"; }
    if (reason) await route.abort("blockedbyclient");
    else await route.continue();
  });
};
`;

const NETWORK_POLICY_HELPERS = PLAYWRIGHT_POLICY_SOURCE.slice(0, PLAYWRIGHT_POLICY_SOURCE.indexOf("exports.default"));

/**
 * A loopback-only HTTP/CONNECT proxy that cannot be bypassed by redirects.
 *
 * The template embeds __SWARM_PROXY_VERSION__ in the health endpoint; the
 * exported source replaces it with PLAYWRIGHT_PROXY_VERSION, a content hash
 * of the template, so the launcher can tell a stale proxy (deployed before
 * the current code) from a live one and replace it on startup.
 */
const PROXY_SOURCE_TEMPLATE = NETWORK_POLICY_HELPERS + String.raw`
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

function blockedResponse(res) {
  res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end("SwarmAgents browser policy blocked this private destination.\n");
}
function requestTarget(req) {
  try { return new URL(req.url); } catch {
    try { return new URL("http://" + req.headers.host + req.url); } catch { return null; }
  }
}
const server = http.createServer(async (req, res) => {
  if (req.url === "/__swarm_policy_health") {
    res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end("swarm-playwright-policy __SWARM_PROXY_VERSION__\n");
    return;
  }
  if (req.url === "/__swarm_policy_shutdown" && req.method === "POST") {
    // Loopback-only: the server binds 127.0.0.1, and the remote address is
    // checked again here so a forwarded request cannot kill the proxy.
    const remote = req.socket && req.socket.remoteAddress;
    if (remote && remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Forbidden.\n");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end("shutting down\n");
    // Let the response flush before exiting.
    setTimeout(() => process.exit(0), 50);
    return;
  }
  const target = requestTarget(req);
  if (!target || (target.protocol !== "http:" && target.protocol !== "https:")) {
    blockedResponse(res);
    return;
  }
  // One resolution for the whole request: the verdict and the pinned
  // addresses come from the same lookup, so nothing can change in between.
  const resolved = await resolveTarget(target.toString()).catch(() => ({ reason: "policy check failed", addresses: [] }));
  if (resolved.reason) {
    blockedResponse(res);
    return;
  }
  const headers = { ...req.headers };
  delete headers["proxy-connection"];
  const transport = target.protocol === "https:" ? https : http;
  // Pin the upstream connect to the IP validated above: pass a lookup that
  // answers from the resolved addresses, so the transport never resolves
  // the hostname a second time (DNS-rebinding window). Loopback targets
  // carry no addresses and resolve normally.
  const pinned = resolved.addresses;
  const lookup = pinned.length
    ? (hostname, options, callback) => {
        const family = typeof options === "number" ? options : (options && options.family) || 0;
        // Node 20+ autoSelectFamily calls lookup with { all: true } and
        // expects an array of { address, family } records in return.
        if (options && options.all) {
          const matches = pinned.filter((record) => family === 0 || record.family === family);
          callback(null, (matches.length ? matches : pinned).map((r) => ({ address: r.address, family: r.family })));
          return;
        }
        const match = pinned.find((record) => family === 0 || record.family === family) || pinned[0];
        callback(null, match.address, match.family);
      }
    : undefined;
  const upstream = transport.request(target, { method: req.method, headers, ...(lookup ? { lookup } : {}) }, (reply) => {
    res.writeHead(reply.statusCode || 502, reply.headers);
    reply.pipe(res);
  });
  // An upstream that stalls forever holds a socket pair open and leaks
  // FDs on long-lived VMs; the CONNECT path has the same bound.
  if (typeof upstream.setTimeout === "function") {
    upstream.setTimeout(120000, () => {
      upstream.destroy();
      if (typeof res.destroy === "function") res.destroy();
    });
  }
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("Upstream request failed.\n");
  });
  // If the client goes away mid-response, stop the upstream work too.
  if (typeof res.on === "function") res.on("close", () => upstream.destroy());
  req.pipe(upstream);
});
server.on("connect", async (req, client, head) => {
  // Strict host:port parsing: reject anything smuggling userinfo, a path,
  // a query/fragment, or whitespace (e.g. example.com@10.0.0.1:443).
  const raw = String(req.url || "");
  if (/[@/?#\s]/.test(raw)) {
    client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const lastColon = raw.lastIndexOf(":");
  const port = lastColon > 0 ? Number(raw.slice(lastColon + 1)) : NaN;
  if (lastColon <= 0 || !raw.slice(0, lastColon) || !Number.isInteger(port) || port < 1 || port > 65535) {
    client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  let target;
  try { target = new URL("https://" + raw); } catch {
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  // One resolution for the whole tunnel: the verdict and the pinned address
  // come from the same lookup, so nothing can change in between.
  const resolved = await resolveTarget(target.toString()).catch(() => ({ reason: "policy check failed", addresses: [] }));
  if (resolved.reason) {
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  // Connect to the IP validated by the policy check above, not the hostname:
  // a second DNS resolution here would let a rebinding answer swap in a
  // private address. Loopback and literal-IP targets carry no separate
  // addresses; fall back to the hostname (loopback resolves locally, and a
  // literal IP is its own address).
  const address = resolved.addresses.length ? resolved.addresses[0].address : target.hostname.replace(/^\[|\]$/g, "");
  const upstream = net.connect(port, address, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  // Idle tunnels must not linger forever, and either side going away tears
  // down the peer (not just on error).
  const idleMs = 120000;
  if (typeof upstream.setTimeout === "function") {
    upstream.setTimeout(idleMs, () => { upstream.destroy(); client.destroy(); });
  }
  if (typeof client.setTimeout === "function") {
    client.setTimeout(idleMs, () => { upstream.destroy(); client.destroy(); });
  }
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.on("close", () => upstream.destroy());
});
server.on("error", (err) => {
  // A listen failure (e.g. EADDRINUSE on 18793) must fail fast so the
  // launcher reports the proxy as down instead of leaving a half-started
  // proxy behind; without this handler it is an uncaught exception.
  console.error("[playwright-proxy] server error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
server.listen(18793, "127.0.0.1");
`;

/**
 * Content hash of the proxy source template; changes whenever the proxy
 * code changes, so a launcher from a newer deploy never reuses a stale
 * proxy left behind by an older one.
 */
export const PLAYWRIGHT_PROXY_VERSION: string = createHash("sha256")
  .update(PROXY_SOURCE_TEMPLATE)
  .digest("hex")
  .slice(0, 16);

/** The proxy source with its version embedded in the health endpoint. */
export const PLAYWRIGHT_PROXY_SOURCE = PROXY_SOURCE_TEMPLATE.replaceAll(
  "__SWARM_PROXY_VERSION__",
  PLAYWRIGHT_PROXY_VERSION,
);

/** Start (or reuse) the per-VM proxy, then exec the pinned Playwright MCP. */
export const PLAYWRIGHT_LAUNCHER_SOURCE = String.raw`// SwarmAgents Playwright MCP launcher (CommonJS).
const http = require("node:http");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const proxyOrigin = "http://127.0.0.1:18793";
const expectedVersion = "${PLAYWRIGHT_PROXY_VERSION}";
const proxyLogPath = "/workspace/.swarm/playwright-proxy.log";
const MAX_PROXY_LOG_BYTES = 1024 * 1024;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// "ok" when a proxy with the current version answers, "stale" when an older
// proxy is still listening, "down" when nothing answers.
function healthStatus() {
  return new Promise((resolve) => {
    const req = http.get(proxyOrigin + "/__swarm_policy_health", { timeout: 750 }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve("down");
        resolve(text.trim() === "swarm-playwright-policy " + expectedVersion ? "ok" : "stale");
      });
    });
    req.on("error", () => resolve("down"));
    req.on("timeout", () => { req.destroy(); resolve("down"); });
  });
}
function shutdownStale() {
  return new Promise((resolve) => {
    const req = http.request(proxyOrigin + "/__swarm_policy_shutdown", { method: "POST", timeout: 1000 }, (res) => {
      res.resume();
      res.on("end", () => resolve(true));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}
function rotateProxyLog() {
  try {
    if (fs.existsSync(proxyLogPath) && fs.statSync(proxyLogPath).size > MAX_PROXY_LOG_BYTES) {
      try { fs.unlinkSync(proxyLogPath + ".1"); } catch { /* previous rotation may not exist */ }
      fs.renameSync(proxyLogPath, proxyLogPath + ".1");
    }
  } catch {
    // Best effort: a stale log must never block starting the proxy.
  }
}
async function main() {
  const status = await healthStatus();
  if (status === "stale") {
    // A proxy from an older deploy is still listening: ask it to exit
    // cleanly, then wait for the port to free before starting the new one.
    await shutdownStale();
    for (let i = 0; i < 20; i++) {
      if ((await healthStatus()) === "down") break;
      await sleep(100);
    }
  }
  if (status !== "ok") {
    rotateProxyLog();
    // Proxy stderr goes to a bounded log instead of /dev/null so a crash
    // leaves diagnostics behind; the log rotates once it passes 1 MiB.
    const logFd = fs.openSync(proxyLogPath, "a");
    const proxy = spawn(process.execPath, ["/workspace/.swarm/playwright-proxy.cjs"], {
      detached: true,
      stdio: ["ignore", "ignore", logFd],
    });
    proxy.unref();
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      await sleep(100);
      ready = (await healthStatus()) === "ok";
    }
    if (!ready) throw new Error("Could not start the browser network-policy proxy on loopback port 18793.");
  }
  const args = process.argv.slice(2).concat([
    "--proxy-server", proxyOrigin,
    "--proxy-bypass", "<-loopback>",
  ]);
  const child = spawn("playwright-mcp", args, { stdio: "inherit", env: process.env });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => { throw error; });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code === null ? 1 : code);
  });
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
`;
