import test from "node:test";
import assert from "node:assert/strict";
import {
  assertResolvableProviderBaseUrl,
  isPrivateHostname,
  validateProviderBaseUrl,
} from "./url-safety";

test("public https endpoints are accepted", () => {
  const result = validateProviderBaseUrl("https://api.example.com/v1");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.url.hostname, "api.example.com");
});

test("public http endpoints are rejected", () => {
  const result = validateProviderBaseUrl("http://api.example.com/v1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /https/i);
});

test("loopback and private hosts are allowed for a local runtime", () => {
  for (const url of [
    "http://127.0.0.1:11434",
    "http://localhost:11434",
    "http://192.168.1.20:8000/v1",
    "http://10.0.0.5/v1",
    "http://172.16.4.2/v1",
  ]) {
    const result = validateProviderBaseUrl(url, { serverMode: false });
    assert.equal(result.ok, true, url);
  }
});

test("private hosts are rejected on the shared server unless allowlisted", () => {
  const rejected = validateProviderBaseUrl("http://127.0.0.1:11434", { serverMode: true });
  assert.equal(rejected.ok, false);

  const allowed = validateProviderBaseUrl("http://127.0.0.1:11434", {
    serverMode: true,
    allowHosts: ["127.0.0.1"],
  });
  assert.equal(allowed.ok, true);

  const wildcard = validateProviderBaseUrl("http://box.byoc.example:8080", {
    serverMode: true,
    allowHosts: ["*.byoc.example"],
  });
  assert.equal(wildcard.ok, true);
});

test("cloud metadata hosts are rejected even in local mode", () => {
  for (const url of [
    "http://169.254.169.254/latest/meta-data",
    "http://metadata.google.internal/computeMetadata/v1",
    "http://[fd00:ec2::254]/",
  ]) {
    const result = validateProviderBaseUrl(url, { serverMode: false, allowHosts: ["*"] });
    assert.equal(result.ok, false, url);
  }
});

test("URLs with embedded credentials or non-http schemes are rejected", () => {
  assert.equal(validateProviderBaseUrl("https://user:pass@example.com/v1").ok, false);
  assert.equal(validateProviderBaseUrl("file:///etc/passwd").ok, false);
  assert.equal(validateProviderBaseUrl("").ok, false);
});

test("private range detection covers loopback, RFC1918, CGNAT and IPv6", () => {
  for (const host of [
    "localhost",
    "127.0.0.1",
    "10.1.2.3",
    "172.31.255.255",
    "192.168.0.1",
    "100.64.0.1",
    "169.254.1.1",
    "::1",
    "fd12:3456::1",
    "fe80::1",
    "backend",
  ]) {
    assert.equal(isPrivateHostname(host), true, host);
  }
  assert.equal(isPrivateHostname("8.8.8.8"), false);
  assert.equal(isPrivateHostname("api.example.com"), false);
});

test("resolvable check short-circuits local mode and public IPs", async () => {
  const local = await assertResolvableProviderBaseUrl("http://127.0.0.1:11434", { serverMode: false });
  assert.equal(local.ok, true);

  const publicIp = await assertResolvableProviderBaseUrl("https://1.1.1.1/v1", { serverMode: true });
  assert.equal(publicIp.ok, true);
});
