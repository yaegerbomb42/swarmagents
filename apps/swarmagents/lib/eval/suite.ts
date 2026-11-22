// The stratified benchmark suite: 15 deterministic tasks in 3 buckets.
// Every task is a self-contained fixture (no network, no external MCPs):
// starting code with a planted bug or a stub, grading tests, the correct
// solution, and a plausible-but-wrong fix. Grading runs `node --test` on the
// fixture test file inside an isolated run directory, so a task is only
// "resolved" when the tests actually pass there.
//
// Suite v1 fixtures are synthetic-but-real code. The EvalTaskDef shape
// carries a pinned repoCommit so a future repo-pinned task (checkout at
// that commit, real bug, hidden grading tests) drops in unchanged.

import type { EvalTaskDef } from "./types";

const PIN = "bcba327";

function task(t: EvalTaskDef): EvalTaskDef {
  return t;
}

export const EVAL_SUITE: EvalTaskDef[] = [
  // ---- Bucket A: surgical, single-file bug fixes (target <= 15 turns) ----
  task({
    id: "surgical-rate-limiter-off-by-one",
    bucket: "surgical",
    title: "Sliding-window rate limiter allows limit+1 requests",
    targetTurns: 8,
    repoCommit: PIN,
    description:
      "allow() increments the counter before checking it, so a limit of 3 admits a 4th request inside the window.",
    files: {
      "src/limiter.mjs": `export class SlidingWindowLimiter {
  constructor(limit, windowMs, now = () => Date.now()) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.count = 0;
    this.windowStart = now();
  }
  allow() {
    const t = this.now();
    if (t - this.windowStart >= this.windowMs) {
      this.windowStart = t;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= this.limit + 1;
  }
}
`,
    },
    test: {
      path: "test/limiter.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { SlidingWindowLimiter } from "../src/limiter.mjs";

test("admits exactly limit requests per window, then denies", () => {
  let t = 0;
  const limiter = new SlidingWindowLimiter(3, 1000, () => t);
  assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), false);
});

test("a new window admits again", () => {
  let t = 0;
  const limiter = new SlidingWindowLimiter(2, 1000, () => t);
  limiter.allow();
  limiter.allow();
  assert.equal(limiter.allow(), false);
  t = 1001;
  assert.equal(limiter.allow(), true);
});
`,
    },
    solution: {
      "src/limiter.mjs": `export class SlidingWindowLimiter {
  constructor(limit, windowMs, now = () => Date.now()) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.count = 0;
    this.windowStart = now();
  }
  allow() {
    const t = this.now();
    if (t - this.windowStart >= this.windowMs) {
      this.windowStart = t;
      this.count = 0;
    }
    if (this.count >= this.limit) return false;
    this.count += 1;
    return true;
  }
}
`,
    },
    broken: {
      "src/limiter.mjs": `export class SlidingWindowLimiter {
  constructor(limit, windowMs, now = () => Date.now()) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.count = 0;
    this.windowStart = now();
  }
  allow() {
    const t = this.now();
    if (t - this.windowStart >= this.windowMs) {
      this.windowStart = t;
      this.count = 0;
    }
    if (this.count >= this.limit - 1) return false;
    this.count += 1;
    return true;
  }
}
`,
    },
  }),
  task({
    id: "surgical-ttl-cache-never-expires",
    bucket: "surgical",
    title: "TTL cache get() ignores expiry",
    targetTurns: 6,
    repoCommit: PIN,
    description:
      "Entries are stored with an expiresAt but get() never checks it, so expired values are served forever.",
    files: {
      "src/cache.mjs": `export class TtlCache {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.store = new Map();
  }
  set(key, value, ttlMs) {
    this.store.set(key, { value, expiresAt: this.now() + ttlMs });
  }
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    return entry.value;
  }
  delete(key) {
    return this.store.delete(key);
  }
}
`,
    },
    test: {
      path: "test/cache.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { TtlCache } from "../src/cache.mjs";

test("returns a fresh entry", () => {
  let t = 1000;
  const cache = new TtlCache(() => t);
  cache.set("a", 1, 100);
  assert.equal(cache.get("a"), 1);
});

test("expired entries are gone", () => {
  let t = 1000;
  const cache = new TtlCache(() => t);
  cache.set("a", 1, 100);
  t = 1101;
  assert.equal(cache.get("a"), undefined);
});

test("an entry inside its TTL is still served", () => {
  let t = 1000;
  const cache = new TtlCache(() => t);
  cache.set("a", 1, 100);
  t = 1099;
  assert.equal(cache.get("a"), 1);
});
`,
    },
    solution: {
      "src/cache.mjs": `export class TtlCache {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.store = new Map();
  }
  set(key, value, ttlMs) {
    this.store.set(key, { value, expiresAt: this.now() + ttlMs });
  }
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }
  delete(key) {
    return this.store.delete(key);
  }
}
`,
    },
    broken: {
      "src/cache.mjs": `export class TtlCache {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.store = new Map();
    this.createdAt = now();
  }
  set(key, value, ttlMs) {
    this.store.set(key, { value, expiresAt: this.now() + ttlMs });
  }
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.now() > this.createdAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }
  delete(key) {
    return this.store.delete(key);
  }
}
`,
    },
  }),
  task({
    id: "surgical-csv-quoted-comma",
    bucket: "surgical",
    title: "CSV parser splits inside quoted fields",
    targetTurns: 8,
    repoCommit: PIN,
    description:
      "parseLine splits on every comma, so a quoted field containing a comma is torn in two.",
    files: {
      "src/csv.mjs": `export function parseLine(line) {
  return line.split(",");
}
`,
    },
    test: {
      path: "test/csv.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { parseLine } from "../src/csv.mjs";

test("plain fields split on commas", () => {
  assert.deepEqual(parseLine("a,b,c"), ["a", "b", "c"]);
});

test("a quoted comma stays inside its field", () => {
  assert.deepEqual(parseLine('a,"b,c",d'), ["a", "b,c", "d"]);
});

test("doubled quotes unescape to one quote", () => {
  assert.deepEqual(parseLine('"say ""hi""",x'), ['say "hi"', "x"]);
});
`,
    },
    solution: {
      "src/csv.mjs": `export function parseLine(line) {
  const fields = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}
`,
    },
    broken: {
      "src/csv.mjs": `export function parseLine(line) {
  const fields = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      field += ch;
    } else if (ch === "," && !inQuotes) {
      fields.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}
`,
    },
  }),
  task({
    id: "surgical-retry-throws-first-failure",
    bucket: "surgical",
    title: "retry() throws on the first failure instead of retrying",
    targetTurns: 7,
    repoCommit: PIN,
    description:
      "The helper is supposed to call fn up to retries+1 times; it throws the first error immediately.",
    files: {
      "src/retry.mjs": `export async function retry(fn, { retries = 3 } = {}) {
  return fn();
}
`,
    },
    test: {
      path: "test/retry.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { retry } from "../src/retry.mjs";

test("succeeds after transient failures", async () => {
  let calls = 0;
  const value = await retry(
    async () => {
      calls++;
      if (calls < 3) throw new Error("flaky");
      return "ok";
    },
    { retries: 3 }
  );
  assert.equal(value, "ok");
  assert.equal(calls, 3);
});

test("throws after exhausting retries", async () => {
  let calls = 0;
  await assert.rejects(
    retry(
      async () => {
        calls++;
        throw new Error("always");
      },
      { retries: 2 }
    ),
    /always/
  );
  assert.equal(calls, 3);
});
`,
    },
    solution: {
      "src/retry.mjs": `export async function retry(fn, { retries = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
`,
    },
    broken: {
      "src/retry.mjs": `export async function retry(fn, { retries = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
    }
  }
  return undefined;
}
`,
    },
  }),
  task({
    id: "surgical-url-double-encode",
    bucket: "surgical",
    title: "URL builder encodes the separators, not just the values",
    targetTurns: 6,
    repoCommit: PIN,
    description:
      "buildUrl runs encodeURIComponent over the whole 'k=v' pair, so '=' and '&' come out percent-encoded.",
    files: {
      "src/url.mjs": `export function buildUrl(base, params) {
  const pairs = Object.entries(params).map(
    ([k, v]) => encodeURIComponent(k + "=" + String(v))
  );
  return base + "?" + pairs.join("&");
}
`,
    },
    test: {
      path: "test/url.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { buildUrl } from "../src/url.mjs";

test("encodes keys and values, keeps separators", () => {
  assert.equal(
    buildUrl("https://x.test/search", { q: "a b", tag: "c&d" }),
    "https://x.test/search?q=a%20b&tag=c%26d"
  );
});

test("plain values pass through", () => {
  assert.equal(
    buildUrl("https://x.test/", { page: 2 }),
    "https://x.test/?page=2"
  );
});
`,
    },
    solution: {
      "src/url.mjs": `export function buildUrl(base, params) {
  const pairs = Object.entries(params).map(
    ([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v))
  );
  return base + "?" + pairs.join("&");
}
`,
    },
    broken: {
      "src/url.mjs": `export function buildUrl(base, params) {
  const pairs = Object.entries(params).map(
    ([k, v]) => encodeURI(k) + "=" + encodeURI(String(v))
  );
  return base + "?" + pairs.join("&");
}
`,
    },
  }),
  // ---- Bucket B: feature, multi-file additions (target <= 80 turns) ----
  task({
    id: "feature-paginate-list",
    bucket: "feature",
    title: "Add pagination to the list endpoint helper",
    targetTurns: 30,
    repoCommit: PIN,
    description:
      "paginate() is an unimplemented stub. Implement page slicing with validation and hasNext/hasPrev metadata.",
    files: {
      "src/paginate.mjs": `export function paginate(items, { page, pageSize }) {
  throw new Error("not implemented");
}
`,
    },
    test: {
      path: "test/paginate.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { paginate } from "../src/paginate.mjs";

const items = Array.from({ length: 25 }, (_, i) => i + 1);

test("middle page slices correctly with navigation flags", () => {
  const out = paginate(items, { page: 2, pageSize: 10 });
  assert.deepEqual(out.items, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.equal(out.page, 2);
  assert.equal(out.total, 25);
  assert.equal(out.totalPages, 3);
  assert.equal(out.hasNext, true);
  assert.equal(out.hasPrev, true);
});

test("last page is short and has no next", () => {
  const out = paginate(items, { page: 3, pageSize: 10 });
  assert.deepEqual(out.items, [21, 22, 23, 24, 25]);
  assert.equal(out.hasNext, false);
  assert.equal(out.hasPrev, true);
});

test("invalid page and pageSize throw RangeError", () => {
  assert.throws(() => paginate(items, { page: 0, pageSize: 10 }), RangeError);
  assert.throws(() => paginate(items, { page: 1, pageSize: 0 }), RangeError);
  assert.throws(() => paginate(items, { page: 1, pageSize: 101 }), RangeError);
});
`,
    },
    solution: {
      "src/paginate.mjs": `export function paginate(items, { page, pageSize }) {
  if (!Number.isInteger(page) || page < 1) {
    throw new RangeError("page must be an integer >= 1");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new RangeError("pageSize must be an integer between 1 and 100");
  }
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}
`,
    },
    broken: {
      "src/paginate.mjs": `export function paginate(items, { page, pageSize }) {
  if (!Number.isInteger(page) || page < 1) {
    throw new RangeError("page must be an integer >= 1");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new RangeError("pageSize must be an integer between 1 and 100");
  }
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize - 1;
  return {
    items: items.slice(Math.max(0, start), Math.max(0, start) + pageSize),
    page,
    pageSize,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}
`,
    },
  }),
  task({
    id: "feature-ttl-store-sweep",
    bucket: "feature",
    title: "Add a TTL cache layer with expiry sweep to the store",
    targetTurns: 35,
    repoCommit: PIN,
    description:
      "The store is a plain Map wrapper. Add per-key TTL, lazy expiry on get, and a sweep() that drops only expired keys.",
    files: {
      "src/store.mjs": `export class Store {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.map = new Map();
  }
  set(key, value, ttlMs = Infinity) {
    this.map.set(key, value);
  }
  get(key) {
    return this.map.get(key);
  }
  delete(key) {
    return this.map.delete(key);
  }
  size() {
    return this.map.size;
  }
  sweep() {
    return 0;
  }
}
`,
    },
    test: {
      path: "test/store.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";

test("get returns fresh values and undefined for expired ones", () => {
  let t = 0;
  const store = new Store(() => t);
  store.set("a", 1, 100);
  store.set("b", 2, Infinity);
  t = 150;
  assert.equal(store.get("a"), undefined);
  assert.equal(store.get("b"), 2);
});

test("sweep removes only expired keys and reports the count", () => {
  let t = 0;
  const store = new Store(() => t);
  store.set("a", 1, 100);
  store.set("b", 2, 1000);
  store.set("c", 3, Infinity);
  t = 200;
  assert.equal(store.sweep(), 1);
  assert.equal(store.size(), 2);
  assert.equal(store.get("b"), 2);
});

test("delete removes a key", () => {
  const store = new Store();
  store.set("a", 1);
  assert.equal(store.delete("a"), true);
  assert.equal(store.get("a"), undefined);
});
`,
    },
    solution: {
      "src/store.mjs": `export class Store {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.map = new Map();
  }
  set(key, value, ttlMs = Infinity) {
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
  }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }
  delete(key) {
    return this.map.delete(key);
  }
  size() {
    return this.map.size;
  }
  sweep() {
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (this.now() > entry.expiresAt) {
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }
}
`,
    },
    broken: {
      "src/store.mjs": `export class Store {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.map = new Map();
    this.createdAt = now();
  }
  set(key, value, ttlMs = Infinity) {
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
  }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }
  delete(key) {
    return this.map.delete(key);
  }
  size() {
    return this.map.size;
  }
  sweep() {
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (this.now() > this.createdAt) {
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }
}
`,
    },
  }),
  task({
    id: "feature-csv-export",
    bucket: "feature",
    title: "Add CSV export with RFC-style field escaping",
    targetTurns: 28,
    repoCommit: PIN,
    description:
      "toCsv() is an unimplemented stub. Export rows with a header line, quoting fields that contain commas, quotes or newlines and doubling inner quotes.",
    files: {
      "src/export-csv.mjs": `export function toCsv(rows) {
  throw new Error("not implemented");
}
`,
    },
    test: {
      path: "test/export-csv.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { toCsv } from "../src/export-csv.mjs";

test("exports a header plus plain rows", () => {
  assert.equal(
    toCsv([
      { name: "ann", age: 30 },
      { name: "bob", age: 41 },
    ]),
    "name,age\\nann,30\\nbob,41"
  );
});

test("quotes fields with commas and doubles inner quotes", () => {
  assert.equal(
    toCsv([{ name: 'doe, "john"', age: 5 }]),
    'name,age\\n"doe, ""john""",5'
  );
});

test("empty input yields an empty string", () => {
  assert.equal(toCsv([]), "");
});
`,
    },
    solution: {
      "src/export-csv.mjs": `function escapeField(value) {
  const s = String(value);
  if (/[",\\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function toCsv(rows) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeField(row[h] ?? "")).join(","));
  }
  return lines.join("\\n");
}
`,
    },
    broken: {
      "src/export-csv.mjs": `function escapeField(value) {
  const s = String(value);
  if (/[",\\n]/.test(s)) {
    return '"' + s + '"';
  }
  return s;
}

export function toCsv(rows) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeField(row[h] ?? "")).join(","));
  }
  return lines.join("\\n");
}
`,
    },
  }),
  task({
    id: "feature-input-validator",
    bucket: "feature",
    title: "Add a schema validator returning a list of errors",
    targetTurns: 40,
    repoCommit: PIN,
    description:
      "validate() is an unimplemented stub. Check required fields, types, numeric ranges and string patterns, and return every violation as a message.",
    files: {
      "src/validate.mjs": `export function validate(obj, schema) {
  throw new Error("not implemented");
}
`,
    },
    test: {
      path: "test/validate.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/validate.mjs";

const schema = {
  name: { required: true, type: "string", pattern: /^[a-z]+$/ },
  age: { required: true, type: "number", min: 0, max: 120 },
  nick: { required: false, type: "string" },
};

test("a valid object yields no errors", () => {
  assert.deepEqual(validate({ name: "ann", age: 30 }, schema), []);
});

test("missing required fields are reported", () => {
  const errors = validate({ age: 30 }, schema);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /name/);
});

test("wrong types, out-of-range values and bad patterns are all reported", () => {
  const errors = validate({ name: "Ann", age: 200, nick: 7 }, schema);
  assert.equal(errors.length, 3);
  assert.ok(errors.some((e) => e.includes("name")));
  assert.ok(errors.some((e) => e.includes("age")));
  assert.ok(errors.some((e) => e.includes("nick")));
});
`,
    },
    solution: {
      "src/validate.mjs": `export function validate(obj, schema) {
  const errors = [];
  for (const [field, rule] of Object.entries(schema)) {
    const value = obj[field];
    if (value === undefined || value === null) {
      if (rule.required) errors.push(field + " is required");
      continue;
    }
    if (rule.type && typeof value !== rule.type) {
      errors.push(field + " must be a " + rule.type);
      continue;
    }
    if (rule.type === "number") {
      if (rule.min !== undefined && value < rule.min) {
        errors.push(field + " must be >= " + rule.min);
      }
      if (rule.max !== undefined && value > rule.max) {
        errors.push(field + " must be <= " + rule.max);
      }
    }
    if (rule.type === "string" && rule.pattern && !rule.pattern.test(value)) {
      errors.push(field + " does not match " + rule.pattern);
    }
  }
  return errors;
}
`,
    },
    broken: {
      "src/validate.mjs": `export function validate(obj, schema) {
  const errors = [];
  for (const [field, rule] of Object.entries(schema)) {
    const value = obj[field];
    if (value === undefined || value === null) {
      if (rule.required) errors.push(field + " is required");
      continue;
    }
    if (rule.type === "number") {
      if (rule.min !== undefined && value < rule.min) {
        errors.push(field + " must be >= " + rule.min);
      }
      if (rule.max !== undefined && value > rule.max) {
        errors.push(field + " must be <= " + rule.max);
      }
    }
    if (rule.type === "string" && rule.pattern && !rule.pattern.test(value)) {
      errors.push(field + " does not match " + rule.pattern);
    }
  }
  return errors;
}
`,
    },
  }),
  task({
    id: "feature-event-emitter",
    bucket: "feature",
    title: "Add an event emitter with once() and off()",
    targetTurns: 32,
    repoCommit: PIN,
    description:
      "The emitter is an unimplemented stub. Implement on/once/off/emit; emit returns the listener count, once fires a single time.",
    files: {
      "src/emitter.mjs": `export class Emitter {
  on(event, fn) {
    throw new Error("not implemented");
  }
  once(event, fn) {
    throw new Error("not implemented");
  }
  off(event, fn) {
    throw new Error("not implemented");
  }
  emit(event, ...args) {
    throw new Error("not implemented");
  }
}
`,
    },
    test: {
      path: "test/emitter.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { Emitter } from "../src/emitter.mjs";

test("on/emit delivers args and returns the listener count", () => {
  const emitter = new Emitter();
  const seen = [];
  emitter.on("ping", (v) => seen.push(v));
  emitter.on("ping", (v) => seen.push(v * 2));
  assert.equal(emitter.emit("ping", 3), 2);
  assert.deepEqual(seen, [3, 6]);
});

test("once fires exactly one time", () => {
  const emitter = new Emitter();
  let calls = 0;
  emitter.once("tick", () => calls++);
  emitter.emit("tick");
  emitter.emit("tick");
  assert.equal(calls, 1);
});

test("off removes only that listener", () => {
  const emitter = new Emitter();
  let a = 0;
  let b = 0;
  const fnA = () => a++;
  const fnB = () => b++;
  emitter.on("x", fnA);
  emitter.on("x", fnB);
  emitter.off("x", fnA);
  assert.equal(emitter.emit("x"), 1);
  assert.equal(a, 0);
  assert.equal(b, 1);
});

test("emit with no listeners returns 0", () => {
  assert.equal(new Emitter().emit("nothing"), 0);
});
`,
    },
    solution: {
      "src/emitter.mjs": `export class Emitter {
  constructor() {
    this.listeners = new Map();
  }
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push({ fn, once: false });
    return this;
  }
  once(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push({ fn, once: true });
    return this;
  }
  off(event, fn) {
    const list = this.listeners.get(event);
    if (!list) return this;
    const idx = list.findIndex((entry) => entry.fn === fn);
    if (idx !== -1) list.splice(idx, 1);
    return this;
  }
  emit(event, ...args) {
    const list = this.listeners.get(event);
    if (!list || list.length === 0) return 0;
    const snapshot = [...list];
    for (const entry of snapshot) {
      entry.fn(...args);
      if (entry.once) {
        const idx = list.indexOf(entry);
        if (idx !== -1) list.splice(idx, 1);
      }
    }
    return snapshot.length;
  }
}
`,
    },
    broken: {
      "src/emitter.mjs": `export class Emitter {
  constructor() {
    this.listeners = new Map();
  }
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push({ fn, once: false });
    return this;
  }
  once(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push({ fn, once: false });
    return this;
  }
  off(event, fn) {
    const list = this.listeners.get(event);
    if (!list) return this;
    const idx = list.findIndex((entry) => entry.fn === fn);
    if (idx !== -1) list.splice(idx, 1);
    return this;
  }
  emit(event, ...args) {
    const list = this.listeners.get(event);
    if (!list || list.length === 0) return 0;
    const snapshot = [...list];
    for (const entry of snapshot) {
      entry.fn(...args);
    }
    return snapshot.length;
  }
}
`,
    },
  }),
  // ---- Bucket C: long-horizon, 4+ interacting components ----
  task({
    id: "longhorizon-task-queue-ack",
    bucket: "long-horizon",
    title: "Task queue: ack after processing, retry then dead-letter",
    targetTurns: 65,
    repoCommit: PIN,
    description:
      "The worker acks (removes) a job before processing it, so a failing job is lost instead of retried and a permanently failing job never reaches the dead-letter queue.",
    files: {
      "src/queue.mjs": `export class JobQueue {
  constructor() {
    this.pending = [];
    this.deadLetter = [];
  }
  enqueue(job) {
    this.pending.push({ ...job, attempts: 0 });
  }
  take() {
    return this.pending.shift();
  }
  requeue(job) {
    this.pending.push(job);
  }
  toDeadLetter(job) {
    this.deadLetter.push(job);
  }
}
`,
      "src/worker.mjs": `import { JobQueue } from "./queue.mjs";

export const MAX_ATTEMPTS = 3;

export class Worker {
  constructor(queue) {
    this.queue = queue;
  }
  /** Run one job through handler; returns "done" | "retried" | "dead" | "idle". */
  step(handler) {
    const job = this.queue.take();
    if (!job) return "idle";
    try {
      handler(job);
      return "done";
    } catch {
      return "retried";
    }
  }
}
`,
      "src/metrics.mjs": `export class Metrics {
  constructor() {
    this.done = 0;
    this.retried = 0;
    this.dead = 0;
  }
  record(outcome) {
    if (outcome === "done") this.done++;
    else if (outcome === "retried") this.retried++;
    else if (outcome === "dead") this.dead++;
  }
}
`,
    },
    test: {
      path: "test/worker.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { JobQueue } from "../src/queue.mjs";
import { Worker, MAX_ATTEMPTS } from "../src/worker.mjs";
import { Metrics } from "../src/metrics.mjs";

function drive(worker, metrics, handler, steps = 10) {
  for (let i = 0; i < steps; i++) {
    const outcome = worker.step(handler);
    metrics.record(outcome);
    if (outcome === "idle") break;
  }
}

test("a flaky job is retried and eventually succeeds", () => {
  const queue = new JobQueue();
  const worker = new Worker(queue);
  const metrics = new Metrics();
  queue.enqueue({ id: "flaky" });
  let calls = 0;
  drive(worker, metrics, () => {
    calls++;
    if (calls < 3) throw new Error("boom");
  });
  assert.equal(calls, 3);
  assert.equal(metrics.done, 1);
  assert.equal(metrics.retried, 2);
  assert.equal(queue.deadLetter.length, 0);
});

test("a permanently failing job ends in the dead-letter queue", () => {
  const queue = new JobQueue();
  const worker = new Worker(queue);
  const metrics = new Metrics();
  queue.enqueue({ id: "doomed" });
  drive(worker, metrics, () => {
    throw new Error("always");
  });
  assert.equal(queue.deadLetter.length, 1);
  assert.equal(queue.deadLetter[0].id, "doomed");
  assert.equal(queue.deadLetter[0].attempts, MAX_ATTEMPTS);
  assert.equal(metrics.dead, 1);
});
`,
    },
    solution: {
      "src/worker.mjs": `import { JobQueue } from "./queue.mjs";

export const MAX_ATTEMPTS = 3;

export class Worker {
  constructor(queue) {
    this.queue = queue;
  }
  /** Run one job through handler; returns "done" | "retried" | "dead" | "idle". */
  step(handler) {
    const job = this.queue.take();
    if (!job) return "idle";
    try {
      handler(job);
      return "done";
    } catch {
      job.attempts += 1;
      if (job.attempts >= MAX_ATTEMPTS) {
        this.queue.toDeadLetter(job);
        return "dead";
      }
      this.queue.requeue(job);
      return "retried";
    }
  }
}
`,
    },
    broken: {
      "src/worker.mjs": `import { JobQueue } from "./queue.mjs";

export const MAX_ATTEMPTS = 3;

export class Worker {
  constructor(queue) {
    this.queue = queue;
  }
  /** Run one job through handler; returns "done" | "retried" | "dead" | "idle". */
  step(handler) {
    const job = this.queue.take();
    if (!job) return "idle";
    try {
      handler(job);
      return "done";
    } catch {
      if (job.attempts >= MAX_ATTEMPTS) {
        this.queue.toDeadLetter(job);
        return "dead";
      }
      this.queue.requeue({ ...job, attempts: 0 });
      return "retried";
    }
  }
}
`,
    },
  }),
  task({
    id: "longhorizon-router-middleware-order",
    bucket: "long-horizon",
    title: "Router: auth guard and rate limiter must run before the handler",
    targetTurns: 60,
    repoCommit: PIN,
    description:
      "handle() invokes the route handler before the middleware chain, so auth and rate limiting never actually gate anything.",
    files: {
      "src/router.mjs": `export class Router {
  constructor() {
    this.routes = [];
  }
  add(method, path, handler) {
    this.routes.push({ method, path, handler });
  }
  find(method, path) {
    return this.routes.find((r) => r.method === method && r.path === path);
  }
}
`,
      "src/auth.mjs": `export function authGuard(req) {
  if (req.headers?.authorization !== "Bearer secret") {
    return { status: 401, body: "unauthorized" };
  }
  return null;
}
`,
      "src/ratelimit.mjs": `export function makeRateLimiter(limit) {
  let count = 0;
  return function rateLimit(req) {
    count++;
    if (count > limit) return { status: 429, body: "too many requests" };
    return null;
  };
}
`,
      "src/app.mjs": `import { Router } from "./router.mjs";
import { authGuard } from "./auth.mjs";
import { makeRateLimiter } from "./ratelimit.mjs";

export function createApp({ limit = 100 } = {}) {
  const router = new Router();
  const rateLimit = makeRateLimiter(limit);
  const middlewares = [authGuard, rateLimit];
  return {
    router,
    handle(req) {
      const route = router.find(req.method, req.path);
      if (!route) return { status: 404, body: "not found" };
      const result = route.handler(req);
      for (const mw of middlewares) {
        const blocked = mw(req);
        if (blocked) return blocked;
      }
      return result;
    },
  };
}
`,
    },
    test: {
      path: "test/app.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.mjs";

function authed(path = "/data") {
  return { method: "GET", path, headers: { authorization: "Bearer secret" } };
}

test("an unauthenticated request is 401 and the handler never runs", () => {
  const app = createApp();
  let handlerRan = false;
  app.router.add("GET", "/data", () => {
    handlerRan = true;
    return { status: 200, body: "ok" };
  });
  const res = app.handle({ method: "GET", path: "/data", headers: {} });
  assert.equal(res.status, 401);
  assert.equal(handlerRan, false);
});

test("an authenticated request reaches the handler", () => {
  const app = createApp();
  app.router.add("GET", "/data", () => ({ status: 200, body: "ok" }));
  assert.equal(app.handle(authed()).status, 200);
});

test("a rate-limited request is 429 and the handler never runs", () => {
  const app = createApp({ limit: 1 });
  let handlerRuns = 0;
  app.router.add("GET", "/data", () => {
    handlerRuns++;
    return { status: 200, body: "ok" };
  });
  assert.equal(app.handle(authed()).status, 200);
  assert.equal(app.handle(authed()).status, 429);
  assert.equal(handlerRuns, 1);
});

test("unknown routes are 404", () => {
  assert.equal(createApp().handle(authed("/nope")).status, 404);
});
`,
    },
    solution: {
      "src/app.mjs": `import { Router } from "./router.mjs";
import { authGuard } from "./auth.mjs";
import { makeRateLimiter } from "./ratelimit.mjs";

export function createApp({ limit = 100 } = {}) {
  const router = new Router();
  const rateLimit = makeRateLimiter(limit);
  const middlewares = [authGuard, rateLimit];
  return {
    router,
    handle(req) {
      const route = router.find(req.method, req.path);
      if (!route) return { status: 404, body: "not found" };
      for (const mw of middlewares) {
        const blocked = mw(req);
        if (blocked) return blocked;
      }
      return route.handler(req);
    },
  };
}
`,
    },
    broken: {
      "src/app.mjs": `import { Router } from "./router.mjs";
import { authGuard } from "./auth.mjs";
import { makeRateLimiter } from "./ratelimit.mjs";

export function createApp({ limit = 100 } = {}) {
  const router = new Router();
  const rateLimit = makeRateLimiter(limit);
  return {
    router,
    handle(req) {
      const route = router.find(req.method, req.path);
      if (!route) return { status: 404, body: "not found" };
      const blocked = authGuard(req);
      if (blocked) return blocked;
      const result = route.handler(req);
      const limited = rateLimit(req);
      if (limited) return limited;
      return result;
    },
  };
}
`,
    },
  }),
  task({
    id: "longhorizon-db-index-stale",
    bucket: "long-horizon",
    title: "In-memory DB: updates must maintain the secondary index",
    targetTurns: 55,
    repoCommit: PIN,
    description:
      "update() rewrites the row but never touches the secondary index, so findByIndex returns stale rows; transactions must also roll back cleanly.",
    files: {
      "src/table.mjs": `export class Table {
  constructor(indexField) {
    this.indexField = indexField;
    this.rows = new Map();
    this.index = new Map();
  }
  insert(row) {
    this.rows.set(row.id, { ...row });
    this.index.set(row[this.indexField], row.id);
  }
  get(id) {
    const row = this.rows.get(id);
    return row ? { ...row } : undefined;
  }
  findByIndex(value) {
    const id = this.index.get(value);
    return id === undefined ? undefined : this.get(id);
  }
  update(id, patch) {
    const row = this.rows.get(id);
    if (!row) return false;
    Object.assign(row, patch);
    return true;
  }
  delete(id) {
    const row = this.rows.get(id);
    if (!row) return false;
    this.index.delete(row[this.indexField]);
    this.rows.delete(id);
    return true;
  }
}
`,
      "src/tx.mjs": `export class Transaction {
  constructor(table) {
    this.table = table;
    this.snapshot = null;
  }
  begin() {
    this.snapshot = {
      rows: new Map(
        [...this.table.rows.entries()].map(([k, v]) => [k, { ...v }])
      ),
      index: new Map(this.table.index),
    };
  }
  rollback() {
    if (!this.snapshot) return;
    this.table.rows = this.snapshot.rows;
    this.table.index = this.snapshot.index;
    this.snapshot = null;
  }
  commit() {
    this.snapshot = null;
  }
}
`,
      "src/wal.mjs": `export class Wal {
  constructor() {
    this.entries = [];
  }
  append(op) {
    this.entries.push({ ...op, seq: this.entries.length + 1 });
  }
}
`,
    },
    test: {
      path: "test/table.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { Table } from "../src/table.mjs";
import { Transaction } from "../src/tx.mjs";

test("findByIndex follows updates", () => {
  const table = new Table("email");
  table.insert({ id: 1, email: "a@x.test", name: "ann" });
  table.update(1, { email: "b@x.test" });
  assert.equal(table.findByIndex("b@x.test")?.name, "ann");
  assert.equal(table.findByIndex("a@x.test"), undefined);
  assert.equal(table.get(1).email, "b@x.test");
});

test("rollback restores rows and the index", () => {
  const table = new Table("email");
  table.insert({ id: 1, email: "a@x.test", name: "ann" });
  const tx = new Transaction(table);
  tx.begin();
  table.update(1, { email: "b@x.test" });
  tx.rollback();
  assert.equal(table.get(1).email, "a@x.test");
  assert.equal(table.findByIndex("a@x.test")?.id, 1);
  assert.equal(table.findByIndex("b@x.test"), undefined);
});

test("delete removes the row and its index entry", () => {
  const table = new Table("email");
  table.insert({ id: 1, email: "a@x.test" });
  assert.equal(table.delete(1), true);
  assert.equal(table.findByIndex("a@x.test"), undefined);
});
`,
    },
    solution: {
      "src/table.mjs": `export class Table {
  constructor(indexField) {
    this.indexField = indexField;
    this.rows = new Map();
    this.index = new Map();
  }
  insert(row) {
    this.rows.set(row.id, { ...row });
    this.index.set(row[this.indexField], row.id);
  }
  get(id) {
    const row = this.rows.get(id);
    return row ? { ...row } : undefined;
  }
  findByIndex(value) {
    const id = this.index.get(value);
    return id === undefined ? undefined : this.get(id);
  }
  update(id, patch) {
    const row = this.rows.get(id);
    if (!row) return false;
    if (
      patch[this.indexField] !== undefined &&
      patch[this.indexField] !== row[this.indexField]
    ) {
      this.index.delete(row[this.indexField]);
    }
    Object.assign(row, patch);
    this.index.set(row[this.indexField], id);
    return true;
  }
  delete(id) {
    const row = this.rows.get(id);
    if (!row) return false;
    this.index.delete(row[this.indexField]);
    this.rows.delete(id);
    return true;
  }
}
`,
    },
    broken: {
      "src/table.mjs": `export class Table {
  constructor(indexField) {
    this.indexField = indexField;
    this.rows = new Map();
    this.index = new Map();
  }
  insert(row) {
    this.rows.set(row.id, { ...row });
    this.index.set(row[this.indexField], row.id);
  }
  get(id) {
    const row = this.rows.get(id);
    return row ? { ...row } : undefined;
  }
  findByIndex(value) {
    const id = this.index.get(value);
    return id === undefined ? undefined : this.get(id);
  }
  update(id, patch) {
    const row = this.rows.get(id);
    if (!row) return false;
    if (
      patch[this.indexField] !== undefined &&
      patch[this.indexField] !== row[this.indexField]
    ) {
      this.index.delete(row[this.indexField]);
    }
    this.index.set(patch[this.indexField] ?? row[this.indexField], id);
    return true;
  }
  delete(id) {
    const row = this.rows.get(id);
    if (!row) return false;
    this.index.delete(row[this.indexField]);
    this.rows.delete(id);
    return true;
  }
}
`,
    },
  }),
  task({
    id: "longhorizon-pubsub-redelivery",
    bucket: "long-horizon",
    title: "Pub/sub: redelivery must skip acknowledged messages",
    targetTurns: 58,
    repoCommit: PIN,
    description:
      "redeliver() re-queues every message including ones already acked, so consumers see duplicates forever.",
    files: {
      "src/broker.mjs": `export class Broker {
  constructor() {
    this.topics = new Map();
    this.seq = 0;
  }
  publish(topic, payload) {
    if (!this.topics.has(topic)) {
      this.topics.set(topic, { pending: [], acked: new Set() });
    }
    const msg = { id: ++this.seq, topic, payload, attempts: 0 };
    this.topics.get(topic).pending.push(msg);
    return msg.id;
  }
  consume(topic) {
    const state = this.topics.get(topic);
    if (!state) return undefined;
    const msg = state.pending.shift();
    if (msg) msg.attempts++;
    return msg;
  }
  ack(topic, id) {
    const state = this.topics.get(topic);
    if (!state) return false;
    state.acked.add(id);
    return true;
  }
  redeliver(topic) {
    const state = this.topics.get(topic);
    if (!state) return 0;
    const unacked = state.pending.filter((m) => !state.acked.has(m.id));
    state.pending = [...state.pending, ...unacked];
    return unacked.length;
  }
}
`,
    },
    test: {
      path: "test/broker.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { Broker } from "../src/broker.mjs";

test("publish/consume/ack flows in order", () => {
  const broker = new Broker();
  const id1 = broker.publish("jobs", "a");
  const id2 = broker.publish("jobs", "b");
  assert.equal(broker.consume("jobs").payload, "a");
  assert.equal(broker.consume("jobs").payload, "b");
  assert.equal(broker.ack("jobs", id1), true);
  assert.equal(broker.consume("jobs"), undefined);
});

test("redeliver re-queues only unacked messages, once", () => {
  const broker = new Broker();
  const id1 = broker.publish("jobs", "a");
  broker.publish("jobs", "b");
  const first = broker.consume("jobs");
  assert.equal(first.id, id1);
  broker.ack("jobs", id1);
  const second = broker.consume("jobs");
  assert.equal(second.payload, "b");
  assert.equal(broker.redeliver("jobs"), 1);
  const redelivered = broker.consume("jobs");
  assert.equal(redelivered.payload, "b");
  assert.equal(redelivered.attempts, 2);
  assert.equal(broker.consume("jobs"), undefined);
});
`,
    },
    solution: {
      "src/broker.mjs": `export class Broker {
  constructor() {
    this.topics = new Map();
    this.seq = 0;
  }
  publish(topic, payload) {
    if (!this.topics.has(topic)) {
      this.topics.set(topic, { pending: [], inflight: [], acked: new Set() });
    }
    const msg = { id: ++this.seq, topic, payload, attempts: 0 };
    this.topics.get(topic).pending.push(msg);
    return msg.id;
  }
  consume(topic) {
    const state = this.topics.get(topic);
    if (!state) return undefined;
    const msg = state.pending.shift();
    if (msg) {
      msg.attempts++;
      state.inflight.push(msg);
    }
    return msg;
  }
  ack(topic, id) {
    const state = this.topics.get(topic);
    if (!state) return false;
    state.acked.add(id);
    state.inflight = state.inflight.filter((m) => m.id !== id);
    return true;
  }
  redeliver(topic) {
    const state = this.topics.get(topic);
    if (!state) return 0;
    const unacked = state.inflight.filter((m) => !state.acked.has(m.id));
    state.inflight = [];
    state.pending = [...unacked, ...state.pending];
    return unacked.length;
  }
}
`,
    },
    broken: {
      "src/broker.mjs": `export class Broker {
  constructor() {
    this.topics = new Map();
    this.seq = 0;
  }
  publish(topic, payload) {
    if (!this.topics.has(topic)) {
      this.topics.set(topic, { pending: [], inflight: [], acked: new Set() });
    }
    const msg = { id: ++this.seq, topic, payload, attempts: 0 };
    this.topics.get(topic).pending.push(msg);
    return msg.id;
  }
  consume(topic) {
    const state = this.topics.get(topic);
    if (!state) return undefined;
    const msg = state.pending.shift();
    if (msg) {
      msg.attempts++;
      state.inflight.push(msg);
    }
    return msg;
  }
  ack(topic, id) {
    const state = this.topics.get(topic);
    if (!state) return false;
    state.acked.add(id);
    state.inflight = state.inflight.filter((m) => m.id !== id);
    return true;
  }
  redeliver(topic) {
    const state = this.topics.get(topic);
    if (!state) return 0;
    const acked = state.inflight.filter((m) => state.acked.has(m.id));
    state.inflight = [];
    state.pending = [...acked, ...state.pending];
    return acked.length;
  }
}
`,
    },
  }),
  task({
    id: "longhorizon-filesync-deletions",
    bucket: "long-horizon",
    title: "File sync: diff must report deletions and apply must remove them",
    targetTurns: 62,
    repoCommit: PIN,
    description:
      "diff() only walks the source snapshot, so files deleted from the source are never reported and never removed from the target.",
    files: {
      "src/snapshot.mjs": `export function snapshot(files) {
  return new Map(Object.entries(files));
}
`,
      "src/diff.mjs": `export function diff(source, target) {
  const added = [];
  const modified = [];
  for (const [path, content] of source) {
    if (!target.has(path)) added.push(path);
    else if (target.get(path) !== content) modified.push(path);
  }
  return { added, modified, deleted: [] };
}
`,
      "src/apply.mjs": `export function applyChanges(target, source, changes) {
  for (const path of [...changes.added, ...changes.modified]) {
    target.set(path, source.get(path));
  }
  for (const path of changes.deleted) {
    target.delete(path);
  }
}
`,
      "src/conflicts.mjs": `export function detectConflicts(base, source, target) {
  const conflicts = [];
  for (const [path, content] of source) {
    if (
      base.has(path) &&
      target.has(path) &&
      target.get(path) !== base.get(path) &&
      content !== base.get(path)
    ) {
      conflicts.push(path);
    }
  }
  return conflicts;
}
`,
    },
    test: {
      path: "test/sync.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { snapshot } from "../src/snapshot.mjs";
import { diff } from "../src/diff.mjs";
import { applyChanges } from "../src/apply.mjs";
import { detectConflicts } from "../src/conflicts.mjs";

test("diff reports added, modified and deleted files", () => {
  const source = snapshot({ "a.txt": "1", "b.txt": "2-new" });
  const target = snapshot({ "b.txt": "2", "c.txt": "3" });
  assert.deepEqual(diff(source, target), {
    added: ["a.txt"],
    modified: ["b.txt"],
    deleted: ["c.txt"],
  });
});

test("apply brings the target to the source state", () => {
  const source = snapshot({ "a.txt": "1", "b.txt": "2-new" });
  const target = snapshot({ "b.txt": "2", "c.txt": "3" });
  applyChanges(target, source, diff(source, target));
  assert.deepEqual(Object.fromEntries(target), { "a.txt": "1", "b.txt": "2-new" });
});

test("a both-modified file is a conflict", () => {
  const base = snapshot({ "a.txt": "1" });
  const source = snapshot({ "a.txt": "2" });
  const target = snapshot({ "a.txt": "3" });
  assert.deepEqual(detectConflicts(base, source, target), ["a.txt"]);
  const clean = snapshot({ "a.txt": "1" });
  assert.deepEqual(detectConflicts(base, source, clean), []);
});
`,
    },
    solution: {
      "src/diff.mjs": `export function diff(source, target) {
  const added = [];
  const modified = [];
  const deleted = [];
  for (const [path, content] of source) {
    if (!target.has(path)) added.push(path);
    else if (target.get(path) !== content) modified.push(path);
  }
  for (const path of target.keys()) {
    if (!source.has(path)) deleted.push(path);
  }
  return { added, modified, deleted };
}
`,
    },
    broken: {
      "src/diff.mjs": `export function diff(source, target) {
  const added = [];
  const modified = [];
  const deleted = [];
  for (const [path, content] of source) {
    if (!target.has(path)) added.push(path);
    else if (target.get(path) !== content) modified.push(path);
  }
  for (const path of target.keys()) {
    if (!source.has(path)) deleted.push(path);
  }
  return { added, modified, deleted };
}
`,
      "src/apply.mjs": `export function applyChanges(target, source, changes) {
  for (const path of [...changes.added, ...changes.modified]) {
    target.set(path, source.get(path));
  }
}
`,
    },
  }),
];
