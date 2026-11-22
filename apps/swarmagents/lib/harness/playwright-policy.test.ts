import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { PLAYWRIGHT_LAUNCHER_SOURCE, PLAYWRIGHT_POLICY_SOURCE, PLAYWRIGHT_PROXY_SOURCE } from "./playwright-policy";

type RouteHandler = (route: { abort: (reason: string) => Promise<void>; continue: () => Promise<void> }, request: { url: () => string }) => Promise<void>;

async function policyHandler(): Promise<RouteHandler> {
  const fakeModule = { exports: {} as { default?: (input: { page: unknown }) => Promise<void> } };
  new Function("require", "module", "exports", PLAYWRIGHT_POLICY_SOURCE)(require, fakeModule, fakeModule.exports);
  let handler: RouteHandler | undefined;
  const page = {
    route: async (_pattern: string, fn: RouteHandler) => { handler = fn; },
  };
  await fakeModule.exports.default!({ page });
  assert.ok(handler);
  return handler;
}

async function outcome(handler: RouteHandler, url: string): Promise<"allow" | "deny"> {
  let denied = false;
  await handler({
    abort: async () => { denied = true; },
    continue: async () => {},
  }, { url: () => url });
  return denied ? "deny" : "allow";
}

test("Playwright proxy and launcher sources parse as CommonJS", () => {
  assert.doesNotThrow(() => new vm.Script(PLAYWRIGHT_PROXY_SOURCE));
  assert.doesNotThrow(() => new vm.Script(PLAYWRIGHT_LAUNCHER_SOURCE));
  assert.match(PLAYWRIGHT_LAUNCHER_SOURCE, /--proxy-bypass/);
  assert.match(PLAYWRIGHT_PROXY_SOURCE, /server\.on\("connect"/);
  // The proxy must pin the validated IP (resolveTarget) and handle listen
  // errors instead of crashing on an unhandled 'error' event.
  assert.match(PLAYWRIGHT_PROXY_SOURCE, /resolveTarget\(/);
  assert.match(PLAYWRIGHT_PROXY_SOURCE, /server\.on\("error"/);
});

test("Playwright request guard permits public IPs and explicit VM loopback only", async () => {
  const handler = await policyHandler();
  for (const url of [
    "http://localhost:5173/",
    "http://foo.localhost:5173/",
    "http://LOCALHOST./",
    "http://127.0.0.1:5173/",
    "http://127.8.9.10/",
    "http://[::1]/",
    "https://93.184.216.34/",
  ]) {
    assert.equal(await outcome(handler, url), "allow", url);
  }

  for (const url of [
    "http://10.0.0.4/",
    "http://169.254.169.254/latest/meta-data",
    "http://172.16.0.1/",
    "http://192.168.1.4/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fc00::1]/",
    "http://metadata.google.internal/",
    "http://printer.local/",
    // The proxy's own endpoint must never be reachable through the guard.
    "http://127.0.0.1:18793/",
    "http://[::1]:18793/",
    // Non-HTTP(S) schemes are denied outright, never allowed through.
    "file:///etc/passwd",
    "ws://169.254.169.254/",
    "wss://example.com/",
    "ftp://example.com/",
    // IPv6 zone IDs, multicast, and translation ranges are private.
    "http://[fe80::1%eth0]/",
    "http://[ff02::1]/",
    "http://[fec0::1]/",
    "http://[2002::1]/",
    "http://[2001::1]/",
    "http://[64:ff9b::169.254.169.254]/",
    "http://[::169.254.169.254]/",
    // IPv4 multicast, reserved, benchmarking, and IETF protocol ranges.
    "http://224.0.0.1/",
    "http://240.0.0.1/",
    "http://198.18.0.1/",
    "http://192.0.0.1/",
  ]) {
    assert.equal(await outcome(handler, url), "deny", url);
  }
});

/**
 * The proxy resolves a hostname ONCE per request and connects to the
 * validated IP: a second DNS resolution at connect time would let a changed
 * answer swap in a private address (DNS rebinding). The stub DNS below
 * returns a public IP on the first lookup for a phase and a private IP
 * afterwards — the rebinding answer must never be connected to.
 */
test("Playwright proxy connects to the validated IP, never a rebinding answer", async () => {
  const PUBLIC_IP = "93.184.216.34";
  const REBIND_IP = "10.0.0.5";
  let lookupCalls = 0;
  const dnsLookup = async (): Promise<Array<{ address: string; family: number }>> => {
    lookupCalls += 1;
    return [{ address: lookupCalls === 1 ? PUBLIC_IP : REBIND_IP, family: 4 }];
  };
  const isIP = (host: string): number =>
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ? 4 : host.includes(":") ? 6 : 0;

  const connectCalls: Array<{ port: number; host: string }> = [];
  const requestCalls: Array<{ options: Record<string, unknown> }> = [];
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const fakeServer = {
    on: (event: string, fn: (...args: never[]) => unknown) => {
      handlers.set(event, fn);
    },
    listen: () => {},
  };
  const fakeSocket = () => ({ on: () => {}, pipe: () => {}, write: () => {} });
  const fakeRequest = (_url: unknown, options: Record<string, unknown>) => {
    requestCalls.push({ options });
    return { on: () => {}, pipe: () => {} };
  };
  const requireStub = (specifier: string): unknown => {
    switch (specifier) {
      case "node:dns":
        return { promises: { lookup: dnsLookup } };
      case "node:net":
        return {
          isIP,
          connect: (port: number, host: string, cb?: () => void) => {
            connectCalls.push({ port, host });
            const socket = fakeSocket();
            // Real connects resolve asynchronously; calling back inline
            // would hit the caller's `upstream` TDZ.
            if (cb) queueMicrotask(cb);
            return socket;
          },
        };
      case "node:http":
        return { createServer: (handler: (...args: never[]) => unknown) => {
          handlers.set("__request", handler);
          return fakeServer;
        }, request: fakeRequest };
      case "node:https":
        return { request: fakeRequest };
      case "node:url":
        return { URL };
      default:
        throw new Error(`unexpected require: ${specifier}`);
    }
  };

  new Function("require", "module", "exports", PLAYWRIGHT_PROXY_SOURCE)(
    requireStub,
    { exports: {} },
    {},
  );
  const requestHandler = handlers.get("__request") as unknown as (
    req: Record<string, unknown>,
    res: Record<string, unknown>,
  ) => Promise<void>;
  const connectHandler = handlers.get("connect") as unknown as (
    req: Record<string, unknown>,
    client: Record<string, unknown>,
    head: Buffer,
  ) => Promise<void>;
  assert.ok(requestHandler, "expected an HTTP request handler");
  assert.ok(connectHandler, "expected a CONNECT handler");
  // An error listener must exist so a listen failure is surfaced, not an
  // uncaught exception that kills the proxy.
  assert.ok(handlers.get("error"), "expected a server error listener");

  // --- plain HTTP: one DNS lookup, and the transport's lookup answers it.
  lookupCalls = 0;
  await requestHandler(
    { url: "http://example.com/", method: "GET", headers: { host: "example.com" }, pipe: () => {} },
    { writeHead: () => {}, end: () => {}, headersSent: false },
  );
  assert.equal(lookupCalls, 1, "the HTTP path must resolve exactly once");
  assert.equal(requestCalls.length, 1);
  const lookup = requestCalls[0]!.options.lookup as
    | ((hostname: string, options: number, cb: (err: null, address: string, family: number) => void) => void)
    | undefined;
  assert.ok(lookup, "the upstream request must carry a pinned lookup");
  await new Promise<void>((resolve) => {
    lookup!("example.com", 4, (_err, address, family) => {
      assert.equal(address, PUBLIC_IP);
      assert.equal(family, 4);
      resolve();
    });
  });

  // --- CONNECT tunnel: connects to the validated IP, not the hostname.
  lookupCalls = 0;
  let clientEnded = "";
  await connectHandler(
    { url: "example.com:443" },
    { write: () => {}, end: (data: string) => { clientEnded = data; }, on: () => {}, destroy: () => {}, pipe: () => {} },
    Buffer.alloc(0),
  );
  assert.equal(lookupCalls, 1, "the CONNECT path must resolve exactly once");
  assert.equal(clientEnded, "", "a public target must not be rejected");
  assert.deepEqual(connectCalls, [{ port: 443, host: PUBLIC_IP }]);
});

/** Minimal proxy harness with a caller-controlled DNS lookup. */
function bootProxy(dnsLookup: (host: string) => Promise<Array<{ address: string; family: number }>>) {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const fakeServer = {
    on: (event: string, fn: (...args: never[]) => unknown) => {
      handlers.set(event, fn);
    },
    listen: () => {},
  };
  const connectCalls: Array<{ port: number; host: string }> = [];
  const requestCalls: Array<{ options: Record<string, unknown> }> = [];
  const fakeSocket = () => ({ on: () => {}, pipe: () => {}, write: () => {}, destroy: () => {}, setTimeout: () => {} });
  const fakeRequest = (_url: unknown, options: Record<string, unknown>) => {
    requestCalls.push({ options });
    return { on: () => {}, pipe: () => {} };
  };
  const isIP = (host: string): number =>
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ? 4 : host.includes(":") ? 6 : 0;
  const requireStub = (specifier: string): unknown => {
    switch (specifier) {
      case "node:dns":
        return { promises: { lookup: dnsLookup } };
      case "node:net":
        return {
          isIP,
          connect: (port: number, host: string, cb?: () => void) => {
            connectCalls.push({ port, host });
            const socket = fakeSocket();
            if (cb) queueMicrotask(cb);
            return socket;
          },
        };
      case "node:http":
        return { createServer: (handler: (...args: never[]) => unknown) => {
          handlers.set("__request", handler);
          return fakeServer;
        }, request: fakeRequest };
      case "node:https":
        return { request: fakeRequest };
      case "node:url":
        return { URL };
      default:
        throw new Error(`unexpected require: ${specifier}`);
    }
  };
  new Function("require", "module", "exports", PLAYWRIGHT_PROXY_SOURCE)(
    requireStub,
    { exports: {} },
    {},
  );
  return {
    connectCalls,
    requestCalls,
    requestHandler: handlers.get("__request") as unknown as (
      req: Record<string, unknown>,
      res: Record<string, unknown>,
    ) => Promise<void>,
    connectHandler: handlers.get("connect") as unknown as (
      req: Record<string, unknown>,
      client: Record<string, unknown>,
      head: Buffer,
    ) => Promise<void>,
  };
}

function trackingResponse() {
  let status = 0;
  return {
    status: () => status,
    res: {
      writeHead: (code: number) => { status = code; },
      end: () => {},
      headersSent: false,
    },
  };
}

test("Playwright proxy blocks a ::1 DNS answer (rebinding to loopback)", async () => {
  const { requestHandler } = bootProxy(async () => [{ address: "::1", family: 6 }]);
  const tracking = trackingResponse();
  await requestHandler(
    { url: "http://example.com/", method: "GET", headers: { host: "example.com" }, pipe: () => {} },
    tracking.res,
  );
  assert.equal(tracking.status(), 403);
});

test("Playwright proxy pinned lookup answers { all: true } with a record array", async () => {
  const PUBLIC_IP = "93.184.216.34";
  const { requestHandler, requestCalls } = bootProxy(async () => [{ address: PUBLIC_IP, family: 4 }]);
  await requestHandler(
    { url: "http://example.com/", method: "GET", headers: { host: "example.com" }, pipe: () => {} },
    { writeHead: () => {}, end: () => {}, headersSent: false },
  );
  assert.equal(requestCalls.length, 1);
  const lookup = requestCalls[0]!.options.lookup as (
    hostname: string,
    options: { all: boolean; family: number },
    cb: (err: null, records: Array<{ address: string; family: number }>) => void,
  ) => void;
  assert.ok(lookup, "the upstream request must carry a pinned lookup");
  await new Promise<void>((resolve) => {
    lookup("example.com", { all: true, family: 4 }, (_err, records) => {
      assert.deepEqual(records, [{ address: PUBLIC_IP, family: 4 }]);
      resolve();
    });
  });
});

test("Playwright proxy blocks CONNECT to its own endpoint and rejects smuggled targets", async () => {
  const { connectHandler, connectCalls } = bootProxy(async () => [{ address: "93.184.216.34", family: 4 }]);

  let clientEnded = "";
  const client = {
    write: () => {}, end: (data: string) => { clientEnded = data; },
    on: () => {}, destroy: () => {}, pipe: () => {}, setTimeout: () => {},
  };
  await connectHandler({ url: "127.0.0.1:18793" }, client, Buffer.alloc(0));
  assert.match(clientEnded, /403/);
  assert.deepEqual(connectCalls, [], "a self-loop must never connect upstream");

  clientEnded = "";
  await connectHandler({ url: "example.com@10.0.0.1:443" }, client, Buffer.alloc(0));
  assert.match(clientEnded, /400/);
  assert.deepEqual(connectCalls, [], "a smuggled CONNECT target must never connect upstream");
});

test("Playwright proxy pins loopback CONNECT targets to 127.0.0.1", async () => {
  const { connectHandler, connectCalls } = bootProxy(async () => [{ address: "93.184.216.34", family: 4 }]);
  let clientEnded = "";
  const client = {
    write: () => {}, end: (data: string) => { clientEnded = data; },
    on: () => {}, destroy: () => {}, pipe: () => {}, setTimeout: () => {},
  };
  await connectHandler({ url: "127.0.0.1:5173" }, client, Buffer.alloc(0));
  assert.equal(clientEnded, "", "a dev-server loopback target must not be rejected");
  assert.deepEqual(connectCalls, [{ port: 5173, host: "127.0.0.1" }]);
});
