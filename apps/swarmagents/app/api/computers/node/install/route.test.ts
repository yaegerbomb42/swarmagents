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
 * exits for the long-running worker so the test can inspect the config file.
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

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarm-install-"));
}

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
