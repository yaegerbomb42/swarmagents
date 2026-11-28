import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { NextRequest } from "next/server";
import { GET } from "./route";

const CODE = "ABCDE-FGHIJ";

async function installScript(): Promise<string> {
  const res = await GET(new NextRequest("http://localhost/api/computers/node/install?os=linux"));
  return res.text();
}

function realPython(): string | null {
  const found = spawnSync("which", ["python3"], { encoding: "utf8" });
  const bin = found.status === 0 ? found.stdout.trim() : "";
  return bin || null;
}

/**
 * Fake `curl` records the --data payload and returns a canned pairing response.
 * Fake `python3` forwards `-c` (the JSON parser) to the real interpreter but
 * exits for the long-running worker so the test can inspect the config file;
 * when PY_ARGV is set it also records the worker's argv for inspection.
 */
function fakeBin(dir: string, python: string | null): string {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "curl"),
    `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    --data) printf '%s' "$2" > "$CURL_DATA"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' "$CURL_BODY"
`,
    { mode: 0o755 },
  );
  if (python) {
    fs.writeFileSync(
      path.join(bin, "python3"),
      `#!/bin/sh
if [ "$1" = "-c" ]; then exec "$REAL_PYTHON" "$@"; fi
if [ -n "$PY_ARGV" ]; then printf '%s\n' "$*" >> "$PY_ARGV"; fi
exit 0
`,
      { mode: 0o755 },
    );
  }
  return bin;
}

function runInstaller(
  script: string,
  dir: string,
  bin: string,
  env: Record<string, string>,
  args: string[],
): ReturnType<typeof spawnSync> {
  const file = path.join(dir, "install.sh");
  fs.writeFileSync(file, script, { mode: 0o755 });
  return spawnSync("sh", [file, ...args], {
    env: { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH ?? ""}`, ...env },
    encoding: "utf8",
  });
}

const createdDirs: string[] = [];

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-install-"));
  createdDirs.push(d);
  return d;
}

test.afterEach(() => {
  while (createdDirs.length > 0) {
    const d = createdDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("installer rejects --mode values that could break the pairing JSON", async () => {
  const dir = tmp();
  const marker = path.join(dir, "curl-data");
  const bin = fakeBin(dir, realPython());
  const script = await installScript();
  const body = JSON.stringify({ computer: { id: "cmp_test" }, nodeToken: "A".repeat(64) });

  for (const mode of ['bad"', "host}", "sandbox'", "host docker", "HOST"]) {
    const res = runInstaller(script, dir, bin, { CURL_DATA: marker, CURL_BODY: body }, [
      "--code",
      CODE,
      "--mode",
      mode,
    ]);
    assert.equal(res.status, 2, `--mode ${JSON.stringify(mode)} must fail closed: ${res.stderr}`);
    assert.match(String(res.stderr), /Invalid --mode/, `--mode ${JSON.stringify(mode)} must explain itself`);
  }
  assert.equal(fs.existsSync(marker), false, "an invalid mode must not contact the pairing endpoint");
});

test("installer accepts host, docker and sandbox and emits valid pairing JSON", async () => {
  const python = realPython();
  if (!python) return; // the installer requires python3; nothing to exercise without it
  const dir = tmp();
  const marker = path.join(dir, "curl-data");
  const bin = fakeBin(dir, python);
  const script = await installScript();
  const body = JSON.stringify({ computer: { id: "cmp_test" }, nodeToken: "A".repeat(64) });

  for (const mode of ["host", "docker", "sandbox"]) {
    const res = runInstaller(script, dir, bin, {
      REAL_PYTHON: python,
      CURL_DATA: marker,
      CURL_BODY: body,
    }, ["--code", CODE, "--mode", mode]);
    assert.equal(res.status, 0, `--mode ${mode} must be accepted: ${String(res.stderr)}`);
    assert.equal(res.stderr, "", "a valid install must not print to stderr");
    const payload = JSON.parse(fs.readFileSync(marker, "utf8")) as Record<string, unknown>;
    assert.equal(payload.code, CODE);
    const machine = payload.machine as Record<string, unknown>;
    assert.equal(machine.mode, mode);
    assert.ok(["linux", "macos"].includes(String(machine.os)), `unexpected os ${String(machine.os)}`);
    assert.equal(typeof machine.arch, "string");
  }
});

test("installer parses a mixed-case node token", async () => {
  const python = realPython();
  if (!python) return;
  const dir = tmp();
  const marker = path.join(dir, "curl-data");
  const bin = fakeBin(dir, python);
  const script = await installScript();
  const token = "AbCdEf0123456789".repeat(4); // 64 chars, mixed case
  const body = JSON.stringify({ computer: { id: "cmp_mixed" }, nodeToken: token });

  const res = runInstaller(script, dir, bin, {
    REAL_PYTHON: python,
    CURL_DATA: marker,
    CURL_BODY: body,
  }, ["--code", CODE]);
  assert.equal(res.status, 0, String(res.stderr));

  const config = JSON.parse(
    fs.readFileSync(path.join(dir, ".swarmagents", "computer.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(config.computerId, "cmp_mixed");
  assert.equal(config.nodeToken, token);
});

test("installer rejects a truncated or non-hex node token", async () => {
  const python = realPython();
  if (!python) return;
  const script = await installScript();

  for (const token of ["a".repeat(63), "a".repeat(64) + "b", "z".repeat(64)]) {
    const dir = tmp();
    const marker = path.join(dir, "curl-data");
    const bin = fakeBin(dir, python);
    const body = JSON.stringify({ computer: { id: "cmp_test" }, nodeToken: token });
    const res = runInstaller(script, dir, bin, {
      REAL_PYTHON: python,
      CURL_DATA: marker,
      CURL_BODY: body,
    }, ["--code", CODE]);
    assert.equal(res.status, 1, `token ${JSON.stringify(token.slice(0, 8))}... must be rejected`);
    assert.match(String(res.stderr), /Pairing response was not understood/);
    assert.equal(fs.existsSync(path.join(dir, ".swarmagents", "computer.json")), false);
  }
});

test("installer fails cleanly when a flag is missing its value", async () => {
  const script = await installScript();
  for (const flag of ["--code", "--server", "--mode"]) {
    const dir = tmp();
    const bin = fakeBin(dir, realPython());
    const res = runInstaller(script, dir, bin, {}, [flag]);
    assert.notEqual(res.status, 0, `${flag} with no value must fail`);
    assert.match(String(res.stderr), new RegExp(`Missing value for ${flag}`));
    assert.equal(
      fs.existsSync(path.join(dir, ".swarmagents", "computer.json")),
      false,
      "a missing flag value must not pair",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("installer rejects malicious --server values before contacting it", async () => {
  const script = await installScript();
  const bad = [
    "https://example.com/evil",
    "https://example.com?x=1",
    "https://example.com#frag",
    'https://example.com"',
    "https://example.com\\",
    "https://exa mple.com",
    "javascript:alert(1)",
    "ftp://example.com",
    "https://",
    "https://example.com:badport",
    "https://user:pass@example.com",
    "https://example.com:8080:9090",
  ];
  for (const server of bad) {
    const dir = tmp();
    const marker = path.join(dir, "curl-data");
    const bin = fakeBin(dir, realPython());
    const res = runInstaller(script, dir, bin, { CURL_DATA: marker, CURL_BODY: "{}" }, [
      "--code",
      CODE,
      "--server",
      server,
    ]);
    assert.equal(res.status, 2, `--server ${JSON.stringify(server)} must fail closed: ${res.stderr}`);
    assert.match(String(res.stderr), /Invalid --server/, `--server ${JSON.stringify(server)} must explain itself`);
    assert.equal(fs.existsSync(marker), false, `--server ${JSON.stringify(server)} must not be contacted`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("installer accepts a --server origin with a port and trailing slashes", async () => {
  const python = realPython();
  if (!python) return;
  const dir = tmp();
  const marker = path.join(dir, "curl-data");
  const bin = fakeBin(dir, python);
  const script = await installScript();
  const body = JSON.stringify({ computer: { id: "cmp_test" }, nodeToken: "A".repeat(64) });
  try {
    const res = runInstaller(script, dir, bin, {
      REAL_PYTHON: python,
      CURL_DATA: marker,
      CURL_BODY: body,
    }, ["--code", CODE, "--server", "http://127.0.0.1:8080///"]);
    assert.equal(res.status, 0, String(res.stderr));
    const config = JSON.parse(
      fs.readFileSync(path.join(dir, ".swarmagents", "computer.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(config.server, "http://127.0.0.1:8080");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("installer creates the config directory and file with private permissions", async () => {
  const python = realPython();
  if (!python) return;
  const dir = tmp();
  const marker = path.join(dir, "curl-data");
  const bin = fakeBin(dir, python);
  const script = await installScript();
  const body = JSON.stringify({ computer: { id: "cmp_test" }, nodeToken: "A".repeat(64) });
  try {
    const res = runInstaller(script, dir, bin, {
      REAL_PYTHON: python,
      CURL_DATA: marker,
      CURL_BODY: body,
    }, ["--code", CODE]);
    assert.equal(res.status, 0, String(res.stderr));
    const configDir = path.join(dir, ".swarmagents");
    const configFile = path.join(configDir, "computer.json");
    assert.equal(fs.statSync(configDir).mode & 0o777, 0o700, "config dir must be 0700");
    assert.equal(fs.statSync(configFile).mode & 0o777, 0o600, "config file must be 0600");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("installer never passes the node token on the worker command line", async () => {
  const python = realPython();
  if (!python) return;
  const dir = tmp();
  const marker = path.join(dir, "curl-data");
  const argvFile = path.join(dir, "worker-argv");
  const bin = fakeBin(dir, python);
  const script = await installScript();
  const token = "AbCdEf0123456789".repeat(4);
  const body = JSON.stringify({ computer: { id: "cmp_test" }, nodeToken: token });
  try {
    const res = runInstaller(script, dir, bin, {
      REAL_PYTHON: python,
      CURL_DATA: marker,
      CURL_BODY: body,
      PY_ARGV: argvFile,
    }, ["--code", CODE]);
    assert.equal(res.status, 0, String(res.stderr));
    assert.ok(fs.existsSync(argvFile), "the worker exec must have been reached");
    const argv = fs.readFileSync(argvFile, "utf8");
    assert.doesNotMatch(argv, new RegExp(token), "the node token must not appear in argv");
    assert.doesNotMatch(argv, /[A-Fa-f0-9]{64}/, "no 64-hex token may appear in argv");
    // Only the non-secret worker inputs travel on the command line now.
    assert.match(argv.trim(), /^-\s+(linux|macos)\s+\S+\s+host$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("windows installer enforces parity: validation, -- prompt guard, heartbeat runspace, 401 exit, stream-json/resume, timeout, truncation, and NTFS ACLs", async () => {
  const res = await GET(new NextRequest("http://localhost/api/computers/node/install?os=windows"));
  assert.equal(res.status, 200);
  const ps = await res.text();

  // Parameter validation before pairing request.
  assert.match(ps, /\$Code -notmatch '\^\[A-Za-z0-9-\]\+\$'/);
  assert.match(ps, /\$Mode -cnotin @\("host", "docker", "sandbox"\)/);
  assert.match(ps, /\$Server -notmatch '\^https\?:\/\/\[A-Za-z0-9\.-\]\+\(:\[0-9\]\+\)\?\$'/);

  // NTFS ACL restriction on computer.json.
  assert.match(ps, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(ps, /Set-Acl -Path \$configPath/);
  assert.match(ps, /icacls \$configPath \/inheritance:r/);

  // Background heartbeat runspace while claude executes.
  assert.match(ps, /\[runspacefactory\]::CreateRunspace\(\)/);
  assert.match(ps, /action = "heartbeat"/);

  // HTTP 401 exits cleanly instead of looping forever.
  assert.match(ps, /Test-Unauthorized/);
  assert.match(ps, /\[int\]\$resp\.StatusCode -eq 401/);

  // stream-json + --resume + `--` before $job.prompt + 3600s timeout + body truncation.
  assert.match(ps, /"--output-format", "stream-json"/);
  assert.match(ps, /"--resume", \[string\]\$job\.sessionId/);
  assert.match(ps, /"--", \[string\]\$job\.prompt/);
  assert.match(ps, /\$RUN_TIMEOUT_MS = 3600000/);
  assert.match(ps, /WaitForExit\(\$RUN_TIMEOUT_MS\)/);
  assert.match(ps, /\$MAX_BODY_CHARS = 180000/);
  assert.match(ps, /Limit-Field \$text \$MAX_BODY_CHARS/);
});
