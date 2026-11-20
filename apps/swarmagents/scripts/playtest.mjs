#!/usr/bin/env node
// SwarmAgents playtest helper: sign in as the shared test account and make
// sure its provider keys are loaded. Dependency-free (Node 20+).
//
//   node scripts/playtest.mjs login   # sign in, write a cookie jar for curl/Playwright
//   node scripts/playtest.mjs seed    # login + load provider keys into the test account
//   node scripts/playtest.mjs check   # login + print which providers are connected (masked)
//
// Configuration comes from the environment ONLY. Nothing secret lives in the
// repo and nothing secret is ever printed (keys, passwords and cookies are
// never written to stdout/stderr).
//
//   SWARM_BASE_URL            default https://swarmagents.codes
//   SWARM_TEST_EMAIL          shared test account email        (required)
//   SWARM_TEST_PASSWORD       shared test account password     (required)
//   TEST_PROVIDERS_MANIFEST   (seed) JSON array of
//                             {provider, secretName, baseUrl?, baseUrlName?, apiStyle?, bestModel?}
//                             (a repo variable). Each entry's key is read from the secret named
//                             `secretName` (TEST_<PROVIDER>_API_KEY): from process.env[secretName],
//                             or from ALL_SECRETS_JSON (the workflow passes toJSON(secrets)).
//                             `baseUrlName` names a variable/secret (env, ALL_VARS_JSON or
//                             ALL_SECRETS_JSON) that holds the base URL; `baseUrl` is a literal.
//   SWARM_MANIFEST_FILE       read the manifest from this file instead (local use)
//   SWARM_PROVIDER_KEYS_JSON  alternative/extra (seed): {"groq":["k1","k2"],"openrouter":"k"}
//                             keys are provider-catalog ids (lib/providers/catalog*.ts).
//   SWARM_TEST_SIGNUP=1       if login is rejected, try POST /api/signup once
//                             (works only where the server has SWARM_ALLOW_SIGNUP=1)
//   SWARM_COOKIE_JAR          cookie jar path (default ./.swarm-playtest-cookies, gitignored)

import { writeFileSync, chmodSync, readFileSync } from "node:fs";

const base = (process.env.SWARM_BASE_URL || "https://swarmagents.codes").replace(/\/+$/, "");
const email = process.env.SWARM_TEST_EMAIL;
const password = process.env.SWARM_TEST_PASSWORD;
const jarPath = process.env.SWARM_COOKIE_JAR || ".swarm-playtest-cookies";
const mode = process.argv[2] || "check";

function die(msg) {
  console.error(`playtest: ${msg}`);
  process.exit(1);
}

if (!["login", "seed", "check"].includes(mode)) die("usage: playtest.mjs <login|seed|check>");
if (!email || !password) die("SWARM_TEST_EMAIL and SWARM_TEST_PASSWORD must be set (see docs/playtest/README.md).");

let cookie = "";

async function auth(path) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });
  if (res.ok) {
    const setCookies = res.headers.getSetCookie?.() ?? [];
    cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
    if (!cookie) die(`${path} succeeded but returned no session cookie`);
  }
  return res.status;
}

async function login() {
  let status = await auth("/api/login");
  if (status === 401 && process.env.SWARM_TEST_SIGNUP === "1") {
    const s = await auth("/api/signup");
    console.log(`playtest: signup -> HTTP ${s}`);
    status = s;
  }
  if (!cookie) die(`login failed (HTTP ${status})`);
  console.log(`playtest: signed in to ${base} as the test account`);
}

async function api(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, "content-type": "application/json", origin: base },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, data };
}

function writeJar() {
  writeFileSync(jarPath, `${cookie}\n`, { mode: 0o600 });
  chmodSync(jarPath, 0o600);
  console.log(`playtest: session cookie header written to ${jarPath} (use: curl -H "cookie: $(cat ${jarPath})" ...)`);
}

function parseJson(raw, what) {
  try {
    return JSON.parse(raw);
  } catch {
    die(`${what} is not valid JSON.`);
  }
}

/** Look a name up in env, then in the toJSON(secrets) / toJSON(vars) blobs the workflow passes. */
function lookup(name) {
  if (!name) return undefined;
  if (process.env[name]) return process.env[name];
  for (const blob of ["ALL_SECRETS_JSON", "ALL_VARS_JSON"]) {
    if (!process.env[blob]) continue;
    try {
      const v = JSON.parse(process.env[blob])[name];
      if (typeof v === "string" && v) return v;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/** Build the list of providers to load: [{id, keys, baseUrl?, apiStyle?, models?}]. */
function plan() {
  const out = new Map();
  const manifestRaw =
    process.env.SWARM_MANIFEST_FILE
      ? readFileSync(process.env.SWARM_MANIFEST_FILE, "utf8")
      : process.env.TEST_PROVIDERS_MANIFEST || lookup("TEST_PROVIDERS_MANIFEST");
  if (manifestRaw) {
    const manifest = parseJson(manifestRaw, "the providers manifest");
    if (!Array.isArray(manifest)) die("the providers manifest must be a JSON array.");
    for (const e of manifest) {
      const id = e?.provider;
      const key = lookup(e?.secretName);
      if (!id || !key) {
        console.log(`playtest: ${id ?? "?"}: secret ${e?.secretName ?? "?"} is not available, skipping`);
        continue;
      }
      const baseUrl = e.baseUrl || lookup(e.baseUrlName || e.baseUrlVar || e.baseUrlSecret);
      out.set(id, {
        id,
        keys: [key],
        baseUrl: baseUrl || undefined,
        apiStyle: e.apiStyle || undefined,
        models: e.bestModel ? [e.bestModel] : undefined,
      });
    }
  }
  if (process.env.SWARM_PROVIDER_KEYS_JSON) {
    const map = parseJson(process.env.SWARM_PROVIDER_KEYS_JSON, "SWARM_PROVIDER_KEYS_JSON");
    for (const [id, value] of Object.entries(map)) {
      const keys = (Array.isArray(value) ? value : [value]).filter((k) => typeof k === "string" && k.trim());
      const prev = out.get(id);
      out.set(id, { ...(prev ?? { id }), keys: [...(prev?.keys ?? []), ...keys] });
    }
  }
  return [...out.values()].filter((p) => p.keys.length > 0);
}

async function seed() {
  const providers = plan();
  if (providers.length === 0) die("nothing to seed: set TEST_PROVIDERS_MANIFEST (+ secrets) or SWARM_PROVIDER_KEYS_JSON.");
  const before = await api("GET", "/api/providers");
  const existing = new Map((before.data?.providers ?? []).map((p) => [p.id, p.keyCount ?? 0]));
  let failures = 0;
  for (const p of providers) {
    const { id, keys } = p;
    const have = existing.get(id) ?? 0;
    if (have >= keys.length) {
      console.log(`playtest: ${id}: already has ${have} key(s), skipping`);
      continue;
    }
    // First key creates the provider (with the manifest's model/baseUrl/style),
    // the rest are appended. Re-running with the same set is a no-op above.
    let added = have;
    if (have === 0) {
      const body = { id, apiKey: keys[0] };
      if (p.apiStyle) body.apiStyle = p.apiStyle;
      if (p.baseUrl) body.baseUrl = p.baseUrl;
      if (p.models) body.models = p.models;
      const r = await api("POST", "/api/providers", body);
      if (r.status >= 300) {
        console.log(`playtest: ${id}: create failed (HTTP ${r.status}: ${r.data?.error ?? "unknown"})`);
        failures += 1;
        continue;
      }
      added = 1;
    }
    for (const key of keys.slice(added)) {
      const r = await api("PATCH", "/api/providers", { id, action: "add-key", apiKey: key });
      if (r.status >= 300) {
        console.log(`playtest: ${id}: add-key failed (HTTP ${r.status}: ${r.data?.error ?? "unknown"})`);
        failures += 1;
        break;
      }
      added += 1;
    }
    console.log(`playtest: ${id}: ${added} key(s) loaded`);
  }
  if (failures) process.exitCode = 1;
}

async function check() {
  const r = await api("GET", "/api/providers");
  if (r.status !== 200) die(`GET /api/providers -> HTTP ${r.status}`);
  const rows = (r.data?.providers ?? []).filter((p) => (p.keyCount ?? 0) > 0);
  console.log(`playtest: ${rows.length} provider(s) with keys:`);
  for (const p of rows) console.log(`  - ${p.id}: ${p.keyCount} key(s)`);
  const health = await fetch(`${base}/api/health`).then((x) => x.json()).catch(() => null);
  if (health) console.log(`playtest: health ok=${health.ok ?? "?"} commit=${health.commit ?? health.gitSha ?? "?"}`);
}

await login();
if (mode === "login" || mode === "seed") writeJar();
if (mode === "seed") await seed();
if (mode === "check") await check();
