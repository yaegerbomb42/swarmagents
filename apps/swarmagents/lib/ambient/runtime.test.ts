import test from "node:test";
import assert from "node:assert/strict";
import { clearNavLookupCache } from "../browser/policy";
import { dispatchRemoteDelivery } from "./runtime";

function response(status: number, location?: string): Response {
  return new Response(null, {
    status,
    headers: location ? { location } : undefined,
  });
}

test("webhook delivery rejects loopback, link-local, and RFC1918 targets", async () => {
  clearNavLookupCache();
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input));
    return response(200);
  };
  for (const url of [
    "https://127.0.0.1/hook",
    "https://169.254.169.254/latest/meta-data",
    "https://10.1.2.3/hook",
    "https://192.168.1.9/hook",
    "http://example.com/hook",
  ]) {
    const result = await dispatchRemoteDelivery(url, "{}", { fetchImpl });
    assert.equal(result, "blocked", url);
  }
  assert.deepEqual(calls, []);
});

test("webhook delivery rejects a hostname that resolves to a private address", async () => {
  clearNavLookupCache();
  let called = false;
  const result = await dispatchRemoteDelivery("https://internal.example/hook", "{}", {
    fetchImpl: async () => {
      called = true;
      return response(200);
    },
    lookup: async () => ["10.0.0.8"],
  });
  assert.equal(result, "blocked");
  assert.equal(called, false);
});

test("webhook delivery posts to a public https URL", async () => {
  clearNavLookupCache();
  const calls: string[] = [];
  const result = await dispatchRemoteDelivery("https://hooks.example/deliver", "{\"ok\":true}", {
    fetchImpl: async (input, init) => {
      calls.push(String(input));
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "manual");
      assert.equal(init?.body, "{\"ok\":true}");
      return response(204);
    },
    lookup: async () => ["93.184.216.34"],
  });
  assert.equal(result, "delivered");
  assert.deepEqual(calls, ["https://hooks.example/deliver"]);
});

test("webhook delivery blocks a redirect onto a private address", async () => {
  clearNavLookupCache();
  const calls: string[] = [];
  const result = await dispatchRemoteDelivery("https://hooks.example/deliver", "{}", {
    fetchImpl: async (input) => {
      calls.push(String(input));
      return response(302, "https://127.0.0.1/stolen");
    },
    lookup: async () => ["93.184.216.34"],
  });
  assert.equal(result, "blocked");
  assert.deepEqual(calls, ["https://hooks.example/deliver"]);
});

test("webhook delivery follows a redirect only when the next hop is public https", async () => {
  clearNavLookupCache();
  const calls: string[] = [];
  const result = await dispatchRemoteDelivery("https://hooks.example/deliver", "{}", {
    fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/deliver")) return response(307, "https://hooks.example/next");
      return response(200);
    },
    lookup: async () => ["93.184.216.34"],
  });
  assert.equal(result, "delivered");
  assert.deepEqual(calls, ["https://hooks.example/deliver", "https://hooks.example/next"]);
});
