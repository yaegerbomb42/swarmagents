import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { PLAYWRIGHT_LAUNCHER_SOURCE, PLAYWRIGHT_POLICY_SOURCE, PLAYWRIGHT_PROXY_SOURCE, PLAYWRIGHT_PROXY_VERSION } from "./playwright-policy";

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
  // The proxy version is a 16-hex content hash embedded in the health
  // endpoint and in the launcher, so the launcher can spot a stale proxy.
  assert.match(PLAYWRIGHT_PROXY_VERSION, /^[0-9a-f]{16}$/);
  assert.ok(PLAYWRIGHT_PROXY_SOURCE.includes(`swarm-playwright-policy ${PLAYWRIGHT_PROXY_VERSION}`));
  assert.ok(PLAYWRIGHT_LAUNCHER_SOURCE.includes(PLAYWRIGHT_PROXY_VERSION));
  assert.match(PLAYWRIGHT_PROXY_SOURCE, /__swarm_policy_shutdown/);
  assert.match(PLAYWRIGHT_LAUNCHER_SOURCE, /__swarm_policy_shutdown/);
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
  const upstreamTimeouts: number[] = [];
  const socketTimeouts: number[] = [];
  const fakeSocket = () => ({ on: () => {}, pipe: () => {}, write: () => {}, destroy: () => {}, setTimeout: (ms: number) => { socketTimeouts.push(ms); } });
  const fakeRequest = (_url: unknown, options: Record<string, unknown>) => {
    requestCalls.push({ options });
    return { on: () => {}, pipe: () => {}, setTimeout: (ms: number) => { upstreamTimeouts.push(ms); } };
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
    upstreamTimeouts,
    socketTimeouts,
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

/** Boot the proxy source with a fake process + captured setTimeout (control endpoints). */
function bootProxyControl() {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const fakeServer = {
    on: (event: string, fn: (...args: never[]) => unknown) => {
      handlers.set(event, fn);
    },
    listen: () => {},
  };
  const exits: number[] = [];
  const timeouts: Array<{ fn: () => void; ms: number }> = [];
  const fakeProcess = { exit: (code: number) => { exits.push(code); } };
  const fakeSetTimeout = (fn: () => void, ms: number): number => {
    timeouts.push({ fn, ms });
    return 0;
  };
  const requireStub = (specifier: string): unknown => {
    switch (specifier) {
      case "node:dns":
        return { promises: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] } };
      case "node:net":
        return { isIP: (host: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(host) ? 4 : host.includes(":") ? 6 : 0), connect: () => ({ on: () => {}, pipe: () => {}, write: () => {}, destroy: () => {}, setTimeout: () => {} }) };
      case "node:http":
        return { createServer: (handler: (...args: never[]) => unknown) => {
          handlers.set("__request", handler);
          return fakeServer;
        }, request: () => ({ on: () => {}, pipe: () => {} }) };
      case "node:https":
        return { request: () => ({ on: () => {}, pipe: () => {} }) };
      case "node:url":
        return { URL };
      default:
        throw new Error(`unexpected require: ${specifier}`);
    }
  };
  new Function("require", "module", "exports", "process", "setTimeout", PLAYWRIGHT_PROXY_SOURCE)(
    requireStub,
    { exports: {} },
    {},
    fakeProcess,
    fakeSetTimeout,
  );
  return {
    exits,
    timeouts,
    requestHandler: handlers.get("__request") as unknown as (
      req: Record<string, unknown>,
      res: Record<string, unknown>,
    ) => Promise<void>,
  };
}

function captureResponse() {
  let status = 0;
  let body = "";
  return {
    status: () => status,
    body: () => body,
    res: {
      writeHead: (code: number) => { status = code; },
      end: (text?: string) => { body = text ?? ""; },
      headersSent: false,
    },
  };
}

test("Playwright proxy health endpoint reports its version; shutdown is loopback-only", async () => {
  const { requestHandler, exits, timeouts } = bootProxyControl();

  const health = captureResponse();
  await requestHandler(
    { url: "/__swarm_policy_health", method: "GET", socket: { remoteAddress: "127.0.0.1" } },
    health.res,
  );
  assert.equal(health.status(), 200);
  assert.equal(health.body(), `swarm-playwright-policy ${PLAYWRIGHT_PROXY_VERSION}\n`);

  const shutdown = captureResponse();
  await requestHandler(
    { url: "/__swarm_policy_shutdown", method: "POST", socket: { remoteAddress: "127.0.0.1" } },
    shutdown.res,
  );
  assert.equal(shutdown.status(), 200);
  assert.equal(shutdown.body(), "shutting down\n");
  assert.equal(timeouts.length, 1, "shutdown schedules the exit");
  assert.equal(timeouts[0]!.ms, 50);
  timeouts[0]!.fn();
  assert.deepEqual(exits, [0], "the scheduled exit kills the stale proxy");

  const foreign = captureResponse();
  await requestHandler(
    { url: "/__swarm_policy_shutdown", method: "POST", socket: { remoteAddress: "10.0.0.1" } },
    foreign.res,
  );
  assert.equal(foreign.status(), 403, "a non-loopback shutdown must be refused");
  assert.equal(timeouts.length, 1, "a refused shutdown schedules no exit");
});

test("Playwright proxy bounds idle upstream requests and CONNECT tunnels", async () => {
  const { requestHandler, connectHandler, upstreamTimeouts, socketTimeouts } = bootProxy(
    async () => [{ address: "93.184.216.34", family: 4 }],
  );
  await requestHandler(
    { url: "http://example.com/", method: "GET", headers: { host: "example.com" }, pipe: () => {} },
    { writeHead: () => {}, end: () => {}, headersSent: false },
  );
  assert.deepEqual(upstreamTimeouts, [120000], "the HTTP upstream request must get an idle timeout");

  const clientTimeouts: number[] = [];
  const client = {
    write: () => {}, end: () => {}, on: () => {}, destroy: () => {}, pipe: () => {},
    setTimeout: (ms: number) => { clientTimeouts.push(ms); },
  };
  await connectHandler({ url: "example.com:443" }, client, Buffer.alloc(0));
  assert.deepEqual(socketTimeouts, [120000], "the tunnel upstream socket must get an idle timeout");
  assert.deepEqual(clientTimeouts, [120000], "the tunnel client socket must get an idle timeout");
});

test("Playwright launcher replaces a stale-version proxy and logs its stderr", async () => {
  const CURRENT = PLAYWRIGHT_PROXY_VERSION;
  // Scripted health answers: stale -> down (after shutdown) -> ok.
  const healthScript: Array<{ status: number; body: string } | { error: true }> = [
    { status: 200, body: "swarm-playwright-policy 0000000000000000\n" },
    { error: true },
    { status: 200, body: `swarm-playwright-policy ${CURRENT}\n` },
  ];
  let healthCalls = 0;
  const shutdownCalls: Array<{ url: string; method: string }> = [];
  const spawnCalls: Array<{ cmd: string; args: string[]; options: Record<string, unknown> }> = [];
  const renamed: Array<[string, string]> = [];
  const unlinked: string[] = [];
  const opened: Array<{ path: string; flags: string }> = [];
  const exits: number[] = [];

  function fakeResponse(status: number, body: string) {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    return {
      statusCode: status,
      on: (event: string, fn: (...args: unknown[]) => void) => { handlers[event] = fn; },
      resume: () => {},
      _emit: () => {
        handlers["data"]?.(body);
        handlers["end"]?.();
      },
    };
  }
  const httpStub = {
    get: (url: string, _options: unknown, cb: (res: ReturnType<typeof fakeResponse>) => void) => {
      const handlers: Record<string, (...args: unknown[]) => void> = {};
      const scripted = healthScript[Math.min(healthCalls, healthScript.length - 1)]!;
      healthCalls += 1;
      queueMicrotask(() => {
        if ("error" in scripted) {
          handlers["error"]?.(new Error("ECONNREFUSED"));
          return;
        }
        const res = fakeResponse(scripted.status, scripted.body);
        cb(res);
        res._emit();
      });
      return { on: (event: string, fn: (...args: unknown[]) => void) => { handlers[event] = fn; }, destroy: () => {} };
    },
    request: (url: string, options: { method: string }, cb: (res: ReturnType<typeof fakeResponse>) => void) => {
      const handlers: Record<string, (...args: unknown[]) => void> = {};
      shutdownCalls.push({ url, method: options.method });
      queueMicrotask(() => {
        const res = fakeResponse(200, "shutting down\n");
        cb(res);
        res._emit();
      });
      return { on: (event: string, fn: (...args: unknown[]) => void) => { handlers[event] = fn; }, destroy: () => {}, end: () => {} };
    },
  };
  const fsStub = {
    existsSync: () => true,
    statSync: () => ({ size: 2 * 1024 * 1024 }),
    renameSync: (a: string, b: string) => { renamed.push([a, b]); },
    unlinkSync: (p: string) => { unlinked.push(p); },
    openSync: (p: string, flags: string) => { opened.push({ path: p, flags }); return 9; },
  };
  const requireStub = (specifier: string): unknown => {
    switch (specifier) {
      case "node:http":
        return httpStub;
      case "node:fs":
        return fsStub;
      case "node:child_process":
        return {
          spawn: (cmd: string, args: string[], options: Record<string, unknown>) => {
            spawnCalls.push({ cmd, args, options });
            return { unref: () => {}, on: () => {}, kill: () => {} };
          },
        };
      default:
        throw new Error(`unexpected require: ${specifier}`);
    }
  };
  const processStub = {
    execPath: "/usr/bin/node",
    argv: ["node", "launcher.cjs"],
    env: {},
    on: () => {},
    kill: () => {},
    pid: 123,
    exit: (code: number) => { exits.push(code); },
  };
  new Function("require", "module", "exports", "process", PLAYWRIGHT_LAUNCHER_SOURCE)(
    requireStub,
    { exports: {} },
    {},
    processStub,
  );

  const deadline = Date.now() + 5000;
  while (!spawnCalls.some((c) => c.cmd === "playwright-mcp") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(spawnCalls.some((c) => c.cmd === "playwright-mcp"), "the launcher must exec playwright-mcp");
  assert.deepEqual(
    shutdownCalls,
    [{ url: "http://127.0.0.1:18793/__swarm_policy_shutdown", method: "POST" }],
    "a stale proxy is asked to shut down before replacement",
  );
  assert.equal(spawnCalls[0]!.cmd, "/usr/bin/node");
  assert.deepEqual(spawnCalls[0]!.args, ["/workspace/.swarm/playwright-proxy.cjs"]);
  assert.deepEqual(
    spawnCalls[0]!.options.stdio,
    ["ignore", "ignore", 9],
    "proxy stderr goes to the log file descriptor, not /dev/null",
  );
  assert.deepEqual(
    renamed,
    [["/workspace/.swarm/playwright-proxy.log", "/workspace/.swarm/playwright-proxy.log.1"]],
    "an overgrown proxy log rotates before the new proxy starts",
  );
  assert.deepEqual(unlinked, ["/workspace/.swarm/playwright-proxy.log.1"]);
  assert.deepEqual(opened, [{ path: "/workspace/.swarm/playwright-proxy.log", flags: "a" }]);
  const mcp = spawnCalls.find((c) => c.cmd === "playwright-mcp")!;
  assert.ok(mcp.args.includes("--proxy-server"));
  assert.ok(mcp.args.includes("http://127.0.0.1:18793"));
  assert.ok(mcp.args.includes("--proxy-bypass"));
  assert.deepEqual(exits, [], "the launcher must not exit while replacing the proxy");
});

/** Run the launcher source with stubbed http/fs/child_process/process. */
async function runLauncherStub(opts: {
  argv: string[];
  cdpScript: Array<{ status: number } | { error: true }>;
}): Promise<{
  spawnCalls: Array<{ cmd: string; args: string[]; options: Record<string, unknown> }>;
  exits: number[];
  cdpCalls: number;
  errors: string[];
}> {
  const CURRENT = PLAYWRIGHT_PROXY_VERSION;
  const spawnCalls: Array<{ cmd: string; args: string[]; options: Record<string, unknown> }> = [];
  const exits: number[] = [];
  const errors: string[] = [];
  let cdpCalls = 0;
  const consoleError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    function fakeResponse(status: number) {
      const handlers: Record<string, (...args: unknown[]) => void> = {};
      return {
        statusCode: status,
        on: (event: string, fn: (...args: unknown[]) => void) => {
          handlers[event] = fn;
        },
        resume: () => {},
        _emit: () => {
          handlers["end"]?.();
        },
      };
    }
    const httpStub = {
      get: (url: string, _options: unknown, cb: (res: ReturnType<typeof fakeResponse>) => void) => {
        const handlers: Record<string, (...args: unknown[]) => void> = {};
        queueMicrotask(() => {
          if (url.includes("/json/version")) {
            cdpCalls += 1;
            const scripted = opts.cdpScript[Math.min(cdpCalls - 1, opts.cdpScript.length - 1)]!;
            if ("error" in scripted) {
              handlers["error"]?.(new Error("ECONNREFUSED"));
              return;
            }
            const res = fakeResponse(scripted.status);
            cb(res);
            res._emit();
            return;
          }
          const res = fakeResponse(200);
          cb(res);
          // The health handler reads the body; answer with the current version.
          res._emit();
        });
        return { on: (event: string, fn: (...args: unknown[]) => void) => {
          handlers[event] = fn;
        }, destroy: () => {} };
      },
      request: (_url: string, _options: unknown, cb: (res: ReturnType<typeof fakeResponse>) => void) => {
        const handlers: Record<string, (...args: unknown[]) => void> = {};
        queueMicrotask(() => {
          const res = fakeResponse(200);
          cb(res);
          res._emit();
        });
        return { on: (event: string, fn: (...args: unknown[]) => void) => {
          handlers[event] = fn;
        }, destroy: () => {}, end: () => {} };
      },
    };
    // The health check reads the response body via data events; the stub
    // above emits no data, so patch the health answer: instead of relying
    // on the body, answer health through the same fake with a data event.
    const fsStub = {
      existsSync: () => false,
      statSync: () => ({ size: 0 }),
      renameSync: () => {},
      unlinkSync: () => {},
      openSync: () => 9,
    };
    const requireStub = (specifier: string): unknown => {
      switch (specifier) {
        case "node:http":
          return httpStub;
        case "node:fs":
          return fsStub;
        case "node:child_process":
          return {
            spawn: (cmd: string, args: string[], options: Record<string, unknown>) => {
              spawnCalls.push({ cmd, args, options });
              return { unref: () => {}, on: () => {}, kill: () => {} };
            },
          };
        default:
          throw new Error(`unexpected require: ${specifier}`);
      }
    };
    const processStub = {
      execPath: "/usr/bin/node",
      argv: ["node", "launcher.cjs", ...opts.argv],
      env: {},
      on: () => {},
      kill: () => {},
      pid: 123,
      exit: (code: number) => {
        exits.push(code);
      },
    };
    // The launcher's health check compares the response body to the proxy
    // version; make the stub emit the version line as a data chunk.
    const realGet = httpStub.get;
    httpStub.get = (url: string, options: unknown, cb: (res: ReturnType<typeof fakeResponse>) => void) => {
      if (url.includes("/__swarm_policy_health")) {
        const handlers: Record<string, (...args: unknown[]) => void> = {};
        queueMicrotask(() => {
          const res = {
            statusCode: 200,
            on: (event: string, fn: (...args: unknown[]) => void) => {
              handlers[event] = fn;
            },
            resume: () => {},
          };
          cb(res as never);
          handlers["data"]?.(`swarm-playwright-policy ${CURRENT}\n`);
          handlers["end"]?.();
        });
        return { on: (event: string, fn: (...args: unknown[]) => void) => {
          handlers[event] = fn;
        }, destroy: () => {} };
      }
      return realGet(url, options, cb);
    };
    new Function("require", "module", "exports", "process", PLAYWRIGHT_LAUNCHER_SOURCE)(
      requireStub,
      { exports: {} },
      {},
      processStub,
    );
    const deadline = Date.now() + 15000;
    while (
      !spawnCalls.some((c) => c.cmd === "playwright-mcp") &&
      exits.length === 0 &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return { spawnCalls, exits, cdpCalls, errors };
  } finally {
    console.error = consoleError;
  }
}

test("Playwright launcher waits for the desktop Chromium CDP endpoint before attaching", async () => {
  const { spawnCalls, exits, cdpCalls } = await runLauncherStub({
    argv: ["--cdp-endpoint", "http://127.0.0.1:9222", "--init-page", "/workspace/.swarm/playwright-policy.cjs"],
    cdpScript: [{ error: true }, { status: 200 }],
  });
  const mcp = spawnCalls.find((c) => c.cmd === "playwright-mcp");
  assert.ok(mcp, "the launcher must exec playwright-mcp once CDP answers");
  assert.ok(cdpCalls >= 2, `CDP was probed until it answered (probed ${cdpCalls}x)`);
  assert.deepEqual(
    mcp!.args.slice(0, 2),
    ["--cdp-endpoint", "http://127.0.0.1:9222"],
    "the server attaches via the CDP endpoint, it does not launch a browser",
  );
  assert.ok(!mcp!.args.includes("--browser"), "CDP mode passes no --browser flag");
  assert.ok(mcp!.args.includes("--proxy-server"), "the policy proxy is still applied in CDP mode");
  assert.deepEqual(exits, [], "the launcher must not exit while the server runs");
});

test("Playwright launcher fails clearly when the desktop Chromium CDP endpoint never appears", async () => {
  const { spawnCalls, exits, errors } = await runLauncherStub({
    argv: ["--cdp-endpoint", "http://127.0.0.1:9222", "--init-page", "/workspace/.swarm/playwright-policy.cjs"],
    cdpScript: [{ error: true }],
  });
  assert.equal(spawnCalls.some((c) => c.cmd === "playwright-mcp"), false, "no server starts without a browser to attach to");
  assert.deepEqual(exits, [1], "the launcher exits non-zero");
  assert.ok(errors.some((e) => e.includes("http://127.0.0.1:9222")), "the error names the missing endpoint");
});
