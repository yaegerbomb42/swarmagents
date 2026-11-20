/**
 * Unit tests for the browser URL policy (lib/browser/policy.ts).
 *
 * The policy is a pure function: allowed destinations pass through, private /
 * loopback / non-http destinations are refused with a stable reason. Tests
 * cover the scheme allowlist, every private IPv4 block, IPv6 private space,
 * loopback hostnames, and the URL normalization that the manager relies on.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeNavigation,
  checkNavigation,
  checkNavigationAsync,
  clearNavLookupCache,
  navLookupCacheSize,
  isAddressLiteral,
  isLoopbackHostname,
  isPrivateHost,
  isPrivateHostname,
  normalizeHostname,
  parseNavigationUrl,
} from "./policy";

function allowed(raw: string): void {
  const check = checkNavigation(raw);
  assert.ok(check.ok, `expected ${raw} to be allowed, got: ${JSON.stringify(check)}`);
}

function blocked(raw: string, reasonIncludes?: string): void {
  const check = checkNavigation(raw);
  assert.equal(check.ok, false, `expected ${raw} to be blocked`);
  if (!check.ok && reasonIncludes) {
    assert.ok(check.reason.includes(reasonIncludes), `reason ${check.reason} should mention ${reasonIncludes}`);
  }
}

test("public http/https URLs are allowed", () => {
  allowed("https://example.com/");
  allowed("http://example.com/path?q=1#frag");
  allowed("https://sub.example.co.uk:8443/a");
  allowed("HTTPS://EXAMPLE.COM/"); // scheme case-insensitive
  allowed("https://xn--bcher-kva.example/"); // punycode hostname
  allowed("https://user:pass@example.com/"); // credentials preserved by URL parser
});

test("non-http schemes are blocked", () => {
  blocked("file:///etc/passwd", "Scheme");
  blocked("file:///tmp/secret.pdf", "Scheme");
  blocked("chrome://settings", "Scheme");
  blocked("about:blank", "Scheme");
  blocked("data:text/html,<script>alert(1)</script>", "Scheme");
  blocked("javascript:alert(1)", "Scheme");
  blocked("ftp://example.com/file", "Scheme");
  blocked("ws://example.com", "Scheme");
});

test("malformed URLs are blocked", () => {
  blocked("", "Malformed");
  blocked("   ", "Malformed");
  blocked("not a url", "Malformed");
  blocked("http://", "Malformed"); // no host
  blocked("://missing-scheme", "Malformed");
  blocked("https://exa mple.com", "Malformed");
});

test("RFC 1918 private IPv4 ranges are blocked", () => {
  blocked("http://10.0.0.1/", "Private address 10.0.0.1");
  blocked("http://10.255.255.255/");
  blocked("http://172.16.0.1/");
  blocked("http://172.31.255.255/");
  blocked("http://192.168.0.1/");
  blocked("http://192.168.255.255/");
  allowed("http://172.15.0.1/"); // just outside 172.16/12 is public
  allowed("http://172.32.0.1/");
  allowed("http://11.0.0.1/");
  allowed("http://192.169.0.1/");
});

test("special-purpose IPv4 ranges are blocked", () => {
  blocked("http://127.0.0.1:3777/", "Private address 127.0.0.1");
  blocked("http://127.0.0.1/");
  blocked("http://127.255.255.254/");
  blocked("http://0.0.0.0/");
  blocked("http://0.255.255.255/");
  blocked("http://169.254.169.254/", "Private address 169.254.169.254"); // cloud metadata
  blocked("http://169.254.0.1/");
  blocked("http://100.64.0.1/"); // CGNAT
  blocked("http://100.127.255.255/");
  allowed("http://100.128.0.1/");
});

test("private IPv6 space is blocked", () => {
  blocked("http://[::1]:8080/", "Private address [::1]");
  blocked("http://[::]/");
  blocked("http://[fc00::1]/");
  blocked("http://[fd12:3456:789a::1]/");
  blocked("http://[fe80::1]/");
  blocked("http://[fe90::1]/");
  // IPv4-mapped IPv6 follows the IPv4 rules.
  blocked("http://[::ffff:127.0.0.1]/");
  blocked("http://[::ffff:10.0.0.1]/");
  allowed("http://[2606:4700:4700::1111]/"); // public IPv6
  allowed("http://[2001:4860:4860::8888]/");
  // The dotted-quad mapped form as raw DNS answers carry it (URLs normalize it
  // away, so the direct helpers must still recognize it).
  blocked("http://[::ffff:10.0.0.1]:8080/", "Private address");
  assert.equal(isPrivateHost("::ffff:10.0.0.1"), true);
  assert.equal(isPrivateHost("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateHost("::ffff:169.254.169.254"), true);
  assert.equal(isPrivateHost("::ffff:93.184.216.34"), false); // public IPv4-mapped is allowed
});

test("loopback hostnames are blocked (they resolve into 127.0.0.0/8)", () => {
  blocked("http://localhost:3000/", "Loopback hostname localhost");
  blocked("http://localhost/");
  blocked("http://app.localhost/", "Loopback hostname app.localhost");
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("LOCALHOST"), true);
  assert.equal(isLoopbackHostname("api.localhost"), true);
  assert.equal(isLoopbackHostname("localhost.evil.com"), false);
});

test("address literal detection", () => {
  assert.equal(isAddressLiteral("10.0.0.1"), true);
  assert.equal(isAddressLiteral("999.1.1.1"), false);
  assert.equal(isAddressLiteral("111.1"), false);
  assert.equal(isAddressLiteral("::1"), true);
  assert.equal(isAddressLiteral("::ffff:10.0.0.1"), true);
  assert.equal(isAddressLiteral("example.com"), false);
  assert.equal(isAddressLiteral("meta.0x.example"), false);
  assert.equal(isPrivateHost("10.0.0.1"), true);
  assert.equal(isPrivateHost("8.8.8.8"), false);
  assert.equal(isPrivateHost("::1"), true);
  assert.equal(isPrivateHost("2606:4700:4700::1111"), false);
});

test("normalization: canonical URL is returned on success", () => {
  const check = checkNavigation("  https://example.com:443/a/../b  ");
  assert.equal(check.ok, true);
  if (check.ok) {
    assert.ok(check.url.startsWith("https://example.com/"));
    assert.equal(parseNavigationUrl("HTTPS://EXAMPLE.COM")?.hostname, "example.com");
  }
});

test("assertSafeNavigation throws with the reason", () => {
  assert.throws(() => assertSafeNavigation("file:///etc/passwd"), /Scheme "file"/);
  assert.throws(() => assertSafeNavigation("http://10.0.0.1/"), /Private address 10\.0\.0\.1/);
  assert.throws(() => assertSafeNavigation("http://localhost/"), /Loopback hostname/);
  assert.equal(assertSafeNavigation("https://example.com/"), "https://example.com/");
});

// ---------------------------------------------------------------------------
// b9: SSRF guard bypass — normalized hostnames + private-resolving hostnames.
// ---------------------------------------------------------------------------

test("normalizeHostname canonicalizes dots, case, and root forms", () => {
  assert.equal(normalizeHostname("localhost"), "localhost");
  assert.equal(normalizeHostname("localhost."), "localhost");
  assert.equal(normalizeHostname("LOCALHOST."), "localhost");
  assert.equal(normalizeHostname("  LocalHost.  "), "localhost");
  assert.equal(normalizeHostname("localhost.localdomain."), "localhost.localdomain");
  assert.equal(normalizeHostname("metadata.google.internal"), "metadata.google.internal");
  assert.equal(normalizeHostname("127.0.0.1.nip.io"), "127.0.0.1.nip.io");
  assert.equal(normalizeHostname("example.com"), "example.com");
  assert.equal(normalizeHostname(""), "");
});

test("isPrivateHostname flags reserved special-use hostnames", () => {
  assert.equal(isPrivateHostname("localhost"), true);
  assert.equal(isPrivateHostname("localhost."), true);
  assert.equal(isPrivateHostname("app.localhost"), true);
  assert.equal(isPrivateHostname("foo.local"), true);
  assert.equal(isPrivateHostname("printer.local"), true);
  assert.equal(isPrivateHostname("svc.internal"), true);
  assert.equal(isPrivateHostname("host.localdomain"), true);
  assert.equal(isPrivateHostname("metadata.google.internal"), true);
  assert.equal(isPrivateHostname("example.com"), false);
  assert.equal(isPrivateHostname("localhost.evil.com"), false);
});

test("checkNavigation blocks trailing-dot and reserved hostnames (b9)", () => {
  blocked("http://localhost./");
  blocked("http://LOCALHOST./");
  blocked("http://localhost.localdomain/");
  blocked("http://metadata.google.internal/");
  blocked("http://foo.local/");
  blocked("http://svc.internal/");
  allowed("http://example.com/");
});

test("DNS-aware check blocks every probe URL and allows public ones (b9)", async () => {
  clearNavLookupCache();
  const lookup = async (host: string): Promise<string[]> => {
    const map: Record<string, string[]> = {
      "localtest.me": ["127.0.0.1"],
      "127.0.0.1.nip.io": ["127.0.0.1"],
      "localhost.localdomain": ["127.0.0.1"],
      "metadata.google.internal": ["169.254.169.254"],
      "example.com": ["93.184.216.34"],
      "amazon.com": ["205.251.242.103"],
    };
    return map[host] ?? [];
  };

  const blockedUrls = [
    "http://localhost/",
    "http://169.254.169.254/",
    "http://localhost./",
    "http://LOCALHOST./",
    "http://localtest.me/",
    "http://127.0.0.1.nip.io/",
    "http://localhost.localdomain/",
    "http://metadata.google.internal/",
  ];
  for (const url of blockedUrls) {
    const r = await checkNavigationAsync(url, lookup);
    assert.equal(r.ok, false, `expected blocked: ${url} (got ${JSON.stringify(r)})`);
  }

  for (const url of ["http://example.com/", "http://amazon.com/"]) {
    const r = await checkNavigationAsync(url, lookup);
    assert.equal(r.ok, true, `expected allowed: ${url} (got ${JSON.stringify(r)})`);
  }
});

test("DNS preflight cache sweeps expired hosts and caps unique hosts", async () => {
  clearNavLookupCache();
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const calls = new Map<string, number>();
  const lookup = async (host: string): Promise<string[]> => {
    calls.set(host, (calls.get(host) ?? 0) + 1);
    return ["93.184.216.34"];
  };
  try {
    await checkNavigationAsync("http://stale-a.example/", lookup);
    await checkNavigationAsync("http://stale-b.example/", lookup);
    now += 5_000;
    await checkNavigationAsync("http://fresh.example/", lookup);
    assert.equal(navLookupCacheSize(), 1);
    assert.equal(calls.get("stale-a.example"), 1);

    now += 5_000;
    for (let i = 0; i < 300; i++) {
      await checkNavigationAsync(`http://host-${i}.example/`, lookup);
    }
    assert.ok(navLookupCacheSize() <= 256);
    assert.equal(navLookupCacheSize(), 256);
    const before = calls.get("host-0.example") ?? 0;
    await checkNavigationAsync("http://host-0.example/", lookup);
    assert.equal(calls.get("host-0.example"), before + 1);
    const recentBefore = calls.get("host-299.example") ?? 0;
    await checkNavigationAsync("http://host-299.example/", lookup);
    assert.equal(calls.get("host-299.example"), recentBefore);
    assert.equal(navLookupCacheSize(), 256);
  } finally {
    Date.now = realNow;
    clearNavLookupCache();
  }
});
