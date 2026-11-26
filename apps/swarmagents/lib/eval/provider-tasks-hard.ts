// Harder general tasks for the live provider eval (core-22b).
//
// The first six tasks (provider-tasks.ts) are cleared by a free 30B model in
// ~10 s each, so pass@1 on them cannot tell providers apart. These four need
// real reasoning: a recursive-descent parser with precedence and
// associativity traps, two independent root causes behind one symptom,
// messy-data aggregation checked against an independent recomputation, and
// an LRU/TTL cache whose recency and expiry rules interact. Each verifier
// fails the untouched setup and passes the reference solution
// (lib/eval/provider-tasks.test.ts enforces both).

import type { ProviderEvalTask } from "./provider-types";

export const HARD_PROVIDER_EVAL_TASKS: ProviderEvalTask[] = [
  {
    id: "coding-expr-evaluator",
    category: "coding",
    difficulty: "hard",
    title: "Implement an arithmetic expression evaluator",
    description: "evaluate() is a stub. Needs a tokenizer, precedence climbing with a right-associative ^, unary minus that binds looser than ^, and error handling \u2014 without eval.",
    prompt: "Implement evaluate(src) in src/expr.mjs. It takes an arithmetic expression string and returns its numeric value. Support integer and decimal numbers, + - * / %, ^ for exponentiation (right-associative, and binding tighter than unary minus, so -2^2 is -4 and 2^3^2 is 512), unary minus and plus, parentheses, and any whitespace. Throw an Error for malformed input (empty, unbalanced parentheses, a dangling operator, two numbers in a row, unknown characters) and a RangeError for division or modulo by zero. Do not use eval or Function.",
    setupFiles: {
      "src/expr.mjs": `export function evaluate(src) {
  throw new Error("not implemented");
}
`,
    },
    verifier: {
      path: "test/expr.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluate } from "../src/expr.mjs";

test("arithmetic and precedence", () => {
  assert.equal(evaluate("1 + 2 * 3"), 7);
  assert.equal(evaluate("(1 + 2) * 3"), 9);
  assert.equal(evaluate("10 / 4"), 2.5);
  assert.equal(evaluate("7 % 4"), 3);
  assert.equal(evaluate("  2*(3+4)   - 5 "), 9);
  assert.equal(evaluate("8 - 3 - 2"), 3);
  assert.equal(evaluate("64 / 4 / 2"), 8);
  assert.equal(evaluate("3.5 * 2"), 7);
});

test("exponent is right-associative and binds tighter than unary minus", () => {
  assert.equal(evaluate("2^3^2"), 512);
  assert.equal(evaluate("-2^2"), -4);
  assert.equal(evaluate("(-2)^2"), 4);
  assert.equal(evaluate("2^-1"), 0.5);
});

test("unary operators", () => {
  assert.equal(evaluate("2*-3"), -6);
  assert.equal(evaluate("--3"), 3);
  assert.equal(evaluate("+4"), 4);
  assert.equal(evaluate("-(1+2)*2"), -6);
});

test("malformed input throws", () => {
  for (const bad of ["", "   ", "1 +", "(1 + 2", "1 + 2)", "2 $ 3", "* 3", "1 2", "()", "1..2"]) {
    assert.throws(() => evaluate(bad), Error, \`expected \${JSON.stringify(bad)} to throw\`);
  }
});

test("division and modulo by zero throw RangeError", () => {
  assert.throws(() => evaluate("1/0"), RangeError);
  assert.throws(() => evaluate("5 % (2-2)"), RangeError);
});

test("does not use eval or Function", () => {
  const source = readFileSync(new URL("../src/expr.mjs", import.meta.url), "utf8");
  assert.equal(/\\beval\\s*\\(|\\bFunction\\s*\\(/.test(source), false);
});
`,
    },
    solution: {
      files: {
        "src/expr.mjs": `function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\\s/.test(c)) {
      i += 1;
    } else if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      const text = src.slice(i, j);
      if (!/^(\\d+\\.?\\d*|\\.\\d+)$/.test(text)) throw new Error(\`bad number \${text}\`);
      tokens.push({ type: "num", value: Number(text) });
      i = j;
    } else if ("+-*/%^()".includes(c)) {
      tokens.push({ type: c });
      i += 1;
    } else {
      throw new Error(\`unexpected character \${c}\`);
    }
  }
  return tokens;
}

export function evaluate(src) {
  const tokens = tokenize(String(src));
  let pos = 0;
  const peek = () => tokens[pos]?.type;
  const take = (type) => {
    if (peek() !== type) throw new Error(\`expected \${type}\`);
    return tokens[pos++];
  };

  function expr() {
    let left = term();
    while (peek() === "+" || peek() === "-") {
      const op = tokens[pos++].type;
      const right = term();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }
  function term() {
    let left = unary();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = tokens[pos++].type;
      const right = unary();
      if (op === "*") left *= right;
      else {
        if (right === 0) throw new RangeError("division by zero");
        left = op === "/" ? left / right : left % right;
      }
    }
    return left;
  }
  function unary() {
    if (peek() === "-") {
      pos += 1;
      return -unary();
    }
    if (peek() === "+") {
      pos += 1;
      return unary();
    }
    return power();
  }
  function power() {
    const base = primary();
    if (peek() === "^") {
      pos += 1;
      return base ** unary();
    }
    return base;
  }
  function primary() {
    if (peek() === "num") return tokens[pos++].value;
    if (peek() === "(") {
      pos += 1;
      const value = expr();
      take(")");
      return value;
    }
    throw new Error("expected a number or (");
  }

  if (tokens.length === 0) throw new Error("empty expression");
  const value = expr();
  if (pos !== tokens.length) throw new Error("unexpected trailing input");
  return value;
}
`,
      },
    },
  },
  {
    id: "coding-multifile-invoice",
    category: "coding",
    difficulty: "hard",
    title: "Fix the invoice total (two root causes across modules)",
    description: "invoiceTotal() is wrong for data/orders.csv. Two independent bugs: the CSV parser splits quoted fields on commas, and toCents() floors float cents (19.99*100 = 1998.999...). Only the symptom is given.",
    prompt: "invoiceTotal() in src/report.mjs gives the wrong total for data/orders.csv: the correct total is $119.77. Find and fix the root causes in src/ so totals are correct for any well-formed CSV (including quoted fields with commas or doubled quotes, and CRLF line endings). Do not change data/orders.csv and do not hard-code totals.",
    setupFiles: {
      "data/orders.csv": `item,qty,unit_price
"Widget, large",3,19.99
Bolt,100,0.29
"Cable ""USB-C""",2,4.35
Nut,250,0.07
Gasket,4,1.15
`,
      "src/csv.mjs": `// Parse CSV text with a header row into an array of row objects.
export function parseCsv(text) {
  const lines = text.trim().split(/\\r?\\n/);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row = {};
    header.forEach((name, i) => {
      row[name] = cells[i];
    });
    return row;
  });
}
`,
      "src/money.mjs": `// Money is handled in integer cents.
export function toCents(value) {
  return Math.floor(parseFloat(value) * 100);
}

export function formatCents(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return \`\${sign}$\${Math.floor(abs / 100)}.\${String(abs % 100).padStart(2, "0")}\`;
}
`,
      "src/report.mjs": `import { parseCsv } from "./csv.mjs";
import { toCents, formatCents } from "./money.mjs";

export function lineItems(csvText) {
  return parseCsv(csvText).map((row) => ({
    item: row.item,
    qty: Number(row.qty),
    cents: toCents(row.unit_price) * Number(row.qty),
  }));
}

export function invoiceTotal(csvText) {
  return formatCents(lineItems(csvText).reduce((sum, line) => sum + line.cents, 0));
}
`,
    },
    verifier: {
      path: "test/invoice.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { invoiceTotal, lineItems } from "../src/report.mjs";
import { toCents } from "../src/money.mjs";

const ORDERS = readFileSync(new URL("../data/orders.csv", import.meta.url), "utf8");

test("orders.csv totals correctly", () => {
  assert.equal(invoiceTotal(ORDERS), "$119.77");
});

test("quoted fields keep their commas and quotes", () => {
  const items = lineItems(ORDERS).map((line) => line.item);
  assert.deepEqual(items, ["Widget, large", "Bolt", 'Cable "USB-C"', "Nut", "Gasket"]);
});

test("a different CSV (CRLF, escaped quotes) totals correctly", () => {
  const csv = 'item,qty,unit_price\\r\\n"A ""quoted"", thing",7,2.01\\r\\nB,3,0.57\\r\\n';
  assert.equal(invoiceTotal(csv), "$15.78");
  assert.equal(lineItems(csv)[0].item, 'A "quoted", thing');
});

test("toCents is exact for two-decimal prices", () => {
  for (const [text, cents] of [["19.99", 1999], ["0.29", 29], ["4.35", 435], ["10", 1000], ["1.15", 115], ["0.57", 57]]) {
    assert.equal(toCents(text), cents, text);
  }
});

test("orders.csv is unchanged", () => {
  assert.match(ORDERS, /^item,qty,unit_price\\n"Widget, large",3,19\\.99\\n/);
});
`,
    },
    solution: {
      files: {
        "src/csv.mjs": `// Parse CSV text with a header row into an array of row objects.
// Fields may be quoted; quoted fields can hold commas and doubled quotes.
function parseLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += c;
    }
  }
  cells.push(cell);
  return cells;
}

export function parseCsv(text) {
  const lines = text.trim().split(/\\r?\\n/);
  const header = parseLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseLine(line);
    const row = {};
    header.forEach((name, i) => {
      row[name] = cells[i];
    });
    return row;
  });
}
`,
        "src/money.mjs": `// Money is handled in integer cents.
export function toCents(value) {
  return Math.round(parseFloat(value) * 100);
}

export function formatCents(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return \`\${sign}$\${Math.floor(abs / 100)}.\${String(abs % 100).padStart(2, "0")}\`;
}
`,
      },
    },
  },
  {
    id: "data-sales-summary",
    category: "data",
    difficulty: "hard",
    title: "Summarize messy sales data into summary.json",
    description: "Aggregate data/sales.csv into summary.json: normalized regions sorted by revenue, top product, month series; refunds count negatively. The verifier recomputes every number from the CSV.",
    prompt: "data/sales.csv holds sales rows (date,region,product,units,unit_price). Write summary.json in the workspace root with: totalRevenue (number, in dollars); regions: an array of { region, revenue } sorted by revenue, highest first; topProduct: { product, revenue } for the product with the most revenue; months: an array of { month: \"YYYY-MM\", revenue } in ascending month order. Revenue is units x unit_price; negative units are refunds and reduce revenue. Region names in the file are inconsistent in case and whitespace: normalize them (for example \" NORTH\" and \"north \" are both \"North\"). Amounts must be accurate to the cent. Do not modify data/sales.csv.",
    setupFiles: {
      "data/sales.csv": `date,region,product,units,unit_price
2026-02-08, NORTH,Shelf,3,54.25
2026-01-24,East,Desk,5,189.99
2026-01-11,south,Lamp,1,24.5
2026-03-10,West,Desk,2,189.99
2026-01-23, east,Chair,3,79.95
2026-04-10,south,Chair,3,79.95
2026-04-02,East,Shelf,5,54.25
2026-03-17,WEST,Desk,-2,189.99
2026-04-19,north ,Mat,9,12.4
2026-04-25,West,Lamp,8,24.5
2026-03-04,WEST,Lamp,4,24.5
2026-02-13,North,Shelf,4,54.25
2026-02-01,WEST,Desk,6,189.99
2026-03-21,south,Lamp,2,24.5
2026-02-26,South,Lamp,4,24.5
2026-04-04,south,Lamp,2,24.5
2026-04-23,south,Shelf,8,54.25
2026-01-21,East,Mat,5,12.4
2026-01-01,south,Lamp,6,24.5
2026-01-06,WEST,Desk,-1,189.99
2026-02-12,North,Mat,5,12.4
2026-04-28,North,Lamp,5,24.5
2026-01-19,West,Shelf,6,54.25
2026-01-24,South,Desk,7,189.99
2026-01-07,south,Shelf,1,54.25
2026-04-15,East,Desk,2,189.99
2026-03-03,South,Chair,1,79.95
2026-01-16,south,Lamp,8,24.5
2026-01-09,North,Shelf,4,54.25
2026-04-18,West,Chair,6,79.95
2026-03-28, NORTH,Shelf,-1,54.25
2026-03-09,East,Chair,5,79.95
2026-02-12,WEST,Desk,9,189.99
2026-02-16,WEST,Lamp,7,24.5
2026-02-23,South,Lamp,7,24.5
2026-03-08, NORTH,Mat,3,12.4
`,
    },
    verifier: {
      path: "test/summary.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const csv = readFileSync(new URL("data/sales.csv", root), "utf8");

// Independent recomputation in integer cents.
function expected() {
  const lines = csv.trim().split(/\\r?\\n/).slice(1);
  const region = new Map();
  const product = new Map();
  const month = new Map();
  let total = 0;
  for (const line of lines) {
    const [date, rawRegion, name, units, price] = line.split(",");
    const r = rawRegion.trim().toLowerCase();
    const key = r[0].toUpperCase() + r.slice(1);
    const cents = Number(units) * Math.round(Number(price) * 100);
    region.set(key, (region.get(key) ?? 0) + cents);
    product.set(name, (product.get(name) ?? 0) + cents);
    month.set(date.slice(0, 7), (month.get(date.slice(0, 7)) ?? 0) + cents);
    total += cents;
  }
  return { region, product, month, total };
}

function summary() {
  const path = new URL("summary.json", root);
  assert.ok(existsSync(path), "summary.json must exist in the workspace root");
  return JSON.parse(readFileSync(path, "utf8"));
}

const close = (actual, cents, label) =>
  assert.ok(typeof actual === "number" && Math.abs(actual * 100 - cents) < 0.5, \`\${label}: got \${actual}, want \${cents / 100}\`);

test("total revenue counts refunds negatively", () => {
  close(summary().totalRevenue, expected().total, "totalRevenue");
});

test("regions are normalized, complete, and sorted by revenue descending", () => {
  const s = summary();
  const want = [...expected().region].sort((a, b) => b[1] - a[1]);
  assert.deepEqual(s.regions.map((r) => r.region), want.map(([name]) => name));
  s.regions.forEach((r, i) => close(r.revenue, want[i][1], r.region));
});

test("top product by revenue", () => {
  const s = summary();
  const [name, cents] = [...expected().product].sort((a, b) => b[1] - a[1])[0];
  assert.equal(s.topProduct.product, name);
  close(s.topProduct.revenue, cents, "topProduct");
});

test("months ascending with revenue", () => {
  const s = summary();
  const want = [...expected().month].sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(s.months.map((m) => m.month), want.map(([m]) => m));
  s.months.forEach((m, i) => close(m.revenue, want[i][1], m.month));
});

test("the input data is unchanged", () => {
  assert.equal(csv.split("\\n").length, 38);
  assert.match(csv, /^date,region,product,units,unit_price\\n2026-02-08, NORTH,Shelf,3,54\\.25\\n/);
});
`,
    },
    solution: {
      files: {
        "summarize.mjs": `import { readFileSync, writeFileSync } from "node:fs";

const rows = readFileSync("data/sales.csv", "utf8").trim().split(/\\r?\\n/).slice(1).map((line) => {
  const [date, region, product, units, price] = line.split(",");
  const name = region.trim().toLowerCase();
  return {
    month: date.slice(0, 7),
    region: name.charAt(0).toUpperCase() + name.slice(1),
    product,
    cents: Number(units) * Math.round(Number(price) * 100),
  };
});

const add = (map, key, cents) => map.set(key, (map.get(key) ?? 0) + cents);
const byRegion = new Map();
const byProduct = new Map();
const byMonth = new Map();
for (const row of rows) {
  add(byRegion, row.region, row.cents);
  add(byProduct, row.product, row.cents);
  add(byMonth, row.month, row.cents);
}
const dollars = (cents) => cents / 100;
const total = rows.reduce((sum, row) => sum + row.cents, 0);
const [topName, topCents] = [...byProduct].sort((a, b) => b[1] - a[1])[0];
const summary = {
  totalRevenue: dollars(total),
  regions: [...byRegion].sort((a, b) => b[1] - a[1]).map(([region, cents]) => ({ region, revenue: dollars(cents) })),
  topProduct: { product: topName, revenue: dollars(topCents) },
  months: [...byMonth].sort((a, b) => a[0].localeCompare(b[0])).map(([month, cents]) => ({ month, revenue: dollars(cents) })),
};
writeFileSync("summary.json", JSON.stringify(summary, null, 2) + "\\n");
`,
        "summary.json": `{
  "totalRevenue": 9982.12,
  "regions": [
    {
      "region": "West",
      "revenue": 3930.56
    },
    {
      "region": "South",
      "revenue": 2872.98
    },
    {
      "region": "East",
      "revenue": 2302.78
    },
    {
      "region": "North",
      "revenue": 875.8
    }
  ],
  "topProduct": {
    "product": "Desk",
    "revenue": 5319.72
  },
  "months": [
    {
      "month": "2026-01",
      "revenue": 3355.99
    },
    {
      "month": "2026-02",
      "revenue": 3732.6
    },
    {
      "month": "2026-03",
      "revenue": 609.65
    },
    {
      "month": "2026-04",
      "revenue": 2283.88
    }
  ]
}
`,
      },
    },
  },
  {
    id: "coding-lru-ttl-cache",
    category: "coding",
    difficulty: "hard",
    title: "Implement an LRU cache with per-entry TTL",
    description: "LruTtlCache is a stub. Recency vs expiry interact: get refreshes recency but not TTL, peek refreshes neither, expired entries are invisible and dropped before any live entry is evicted.",
    prompt: "Implement the LruTtlCache class in src/cache.mjs: new LruTtlCache(capacity, ttlMs, now = () => Date.now()). Methods: get(key), peek(key), has(key), set(key, value), delete(key), keys(), and a size getter. Rules: an entry expires ttlMs after it was last set (now() >= setTime + ttlMs means expired); expired entries are invisible to get/peek/has/keys/size. get returns the value and makes the entry most recently used but does not extend its TTL; peek and has change nothing. set on an existing key replaces the value, restarts its TTL and makes it most recent. When a set would exceed capacity, first drop expired entries, then evict the least recently used. capacity 0 stores nothing. delete returns true only if a live entry was removed. keys() lists live keys from least to most recently used. Use the injected now() for all time.",
    setupFiles: {
      "src/cache.mjs": `export class LruTtlCache {
  constructor(capacity, ttlMs, now = () => Date.now()) {
    throw new Error("not implemented");
  }
}
`,
    },
    verifier: {
      path: "test/cache.test.mjs",
      content: `import test from "node:test";
import assert from "node:assert/strict";
import { LruTtlCache } from "../src/cache.mjs";

function clock() {
  const c = { t: 0 };
  c.now = () => c.t;
  return c;
}

test("evicts the least recently used; get refreshes recency, peek does not", () => {
  const c = clock();
  const cache = new LruTtlCache(2, 1000, c.now);
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3);
  assert.equal(cache.has("b"), false);
  assert.deepEqual(cache.keys(), ["a", "c"]);
  assert.equal(cache.peek("a"), 1);
  cache.set("d", 4);
  assert.equal(cache.has("a"), false, "peek must not refresh recency");
  assert.deepEqual(cache.keys(), ["c", "d"]);
});

test("entries expire after ttl and are invisible", () => {
  const c = clock();
  const cache = new LruTtlCache(3, 100, c.now);
  cache.set("a", 1);
  c.t = 99;
  assert.equal(cache.get("a"), 1);
  c.t = 100;
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.peek("a"), undefined);
  assert.equal(cache.has("a"), false);
  assert.equal(cache.size, 0);
});

test("get does not extend the ttl; set does", () => {
  const c = clock();
  const cache = new LruTtlCache(3, 100, c.now);
  cache.set("a", 1);
  c.t = 80;
  cache.get("a");
  c.t = 120;
  assert.equal(cache.get("a"), undefined);
  cache.set("b", 1);
  c.t = 200;
  cache.set("b", 2);
  c.t = 290;
  assert.equal(cache.get("b"), 2);
});

test("a full cache drops expired entries before evicting live ones", () => {
  const c = clock();
  const cache = new LruTtlCache(2, 100, c.now);
  cache.set("old", 1);
  c.t = 60;
  cache.set("fresh", 2);
  cache.get("old");
  c.t = 110;
  cache.set("new", 3);
  assert.deepEqual(cache.keys(), ["fresh", "new"]);
});

test("updating a key replaces its value and makes it most recent", () => {
  const c = clock();
  const cache = new LruTtlCache(2, 1000, c.now);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("a", 10);
  cache.set("c", 3);
  assert.equal(cache.get("a"), 10);
  assert.equal(cache.has("b"), false);
  assert.equal(cache.size, 2);
});

test("delete, size, and capacity 0", () => {
  const c = clock();
  const cache = new LruTtlCache(2, 100, c.now);
  cache.set("a", 1);
  assert.equal(cache.delete("a"), true);
  assert.equal(cache.delete("a"), false);
  cache.set("b", 2);
  c.t = 100;
  assert.equal(cache.delete("b"), false, "deleting an expired entry reports false");
  const none = new LruTtlCache(0, 100, c.now);
  none.set("x", 1);
  assert.equal(none.get("x"), undefined);
  assert.equal(none.size, 0);
});
`,
    },
    solution: {
      files: {
        "src/cache.mjs": `// LRU cache with per-entry TTL. A Map keeps insertion order, which is used
// as recency order: least recently used first.
export class LruTtlCache {
  constructor(capacity, ttlMs, now = () => Date.now()) {
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }

  #live(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  #purgeExpired() {
    const t = this.now();
    for (const [key, entry] of this.entries) {
      if (t >= entry.expiresAt) this.entries.delete(key);
    }
  }

  get(key) {
    const entry = this.#live(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  peek(key) {
    return this.#live(key)?.value;
  }

  has(key) {
    return this.#live(key) !== undefined;
  }

  set(key, value) {
    if (this.capacity <= 0) return this;
    this.entries.delete(key);
    if (this.entries.size >= this.capacity) this.#purgeExpired();
    while (this.entries.size >= this.capacity) {
      this.entries.delete(this.entries.keys().next().value);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    return this;
  }

  delete(key) {
    const live = this.#live(key) !== undefined;
    this.entries.delete(key);
    return live;
  }

  get size() {
    this.#purgeExpired();
    return this.entries.size;
  }

  keys() {
    this.#purgeExpired();
    return [...this.entries.keys()];
  }
}
`,
      },
    },
  },
];
