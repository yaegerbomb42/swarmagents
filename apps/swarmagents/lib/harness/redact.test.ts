/**
 * Unit tests for the pattern-based secret redaction (lib/harness/redact.ts).
 *
 * Every key below is fake — built from literal "FAKE" segments — so these
 * tests exercise the key *shapes* without ever carrying real credentials.
 * The redactor runs on assistant text and tool results alike (see
 * runner.ts), so the cases here cover the shapes at the redactor level and
 * one deep-redaction case for structured tool payloads.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { makeRedactor, redactValue } from "./redact.js";

// Fake keys: every one contains a literal FAKE marker, never real material.
const FAKE_OPENAI = "sk-FAKE-OPENAI-KEY-0123456789ABCDEF01234567";
const FAKE_OPENAI_PROJ = "sk-proj-FAKE-PROJECT-KEY-0123456789ABCDEF01234567";
const FAKE_ANTHROPIC = "sk-ant-api03-FAKE-ANTHROPIC-KEY-0123456789";
const FAKE_GITHUB = "ghp_FAKEGITHUBTOKEN0123456789ABCDEFGH";
const FAKE_GITHUB_FINE = "github_pat_FAKE_FINE_GRAINED_TOKEN_0123456789";
const FAKE_AWS = "AKIAFAKEKEY012345678";
const FAKE_SLACK_BOT = "xoxb-FAKE-SLACK-TOKEN-0123456789";
const FAKE_SLACK_USER = "xoxp-FAKE-SLACK-USER-TOKEN-0123456789";
const FAKE_BEARER = "Bearer FAKEBEARERTOKEN0123456789abcdef";

// Ordinary text that must survive redaction untouched.
const FAKE_HEX_SHA = "0123456789abcdef0123456789abcdef01234567";
const FAKE_SHORT_SHA = "c211c12601fdec50c7bd4e9016b81246df611a6";

test("masks OpenAI-style keys (sk-... and sk-proj-...) without env", () => {
  const redact = makeRedactor({});
  assert.equal(redact(`key is ${FAKE_OPENAI} done`), "key is [REDACTED] done");
  assert.equal(redact(`key is ${FAKE_OPENAI_PROJ} done`), "key is [REDACTED] done");
});

test("masks Anthropic keys (sk-ant-...) without env", () => {
  const redact = makeRedactor({});
  assert.equal(redact(`token ${FAKE_ANTHROPIC} here`), "token [REDACTED] here");
});

test("masks GitHub tokens (ghp_... and github_pat_...) without env", () => {
  const redact = makeRedactor({});
  assert.equal(redact(`token ${FAKE_GITHUB} here`), "token [REDACTED] here");
  assert.equal(redact(`token ${FAKE_GITHUB_FINE} here`), "token [REDACTED] here");
});

test("masks AWS access key IDs (AKIA...) without env", () => {
  const redact = makeRedactor({});
  assert.equal(redact(`id ${FAKE_AWS} here`), "id [REDACTED] here");
});

test("masks Slack tokens (xoxb-... and xoxp-...) without env", () => {
  const redact = makeRedactor({});
  assert.equal(redact(`token ${FAKE_SLACK_BOT} here`), "token [REDACTED] here");
  assert.equal(redact(`token ${FAKE_SLACK_USER} here`), "token [REDACTED] here");
});

test("masks Google/Gemini keys (AIza...) without env", () => {
  const redact = makeRedactor({});
  const key = `AIza${"A".repeat(35)}`;
  assert.equal(redact(`key=${key} done`), "key=[REDACTED] done");
});

test("masks PEM private key headers without env", () => {
  const redact = makeRedactor({});
  const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA";
  assert.equal(redact(text), "[REDACTED]\nMIIEowIBAAKCAQEA");
  assert.equal(redact("-----BEGIN PRIVATE KEY-----"), "[REDACTED]");
});

test("redacts the longer secret first when one is a substring of another", () => {
  const long = "sk-test-abcdefghij1234567890";
  const short = "abcdefghij";
  // The short secret is inserted FIRST: in insertion order it would be
  // redacted first and leave the long token's tail behind
  // ("sk-test-[REDACTED]1234567890"). Longest-first must fully mask both.
  const redactBoth = makeRedactor(undefined, [short, long]);
  assert.equal(redactBoth(`leaked ${long} here`), "leaked [REDACTED] here");
  assert.equal(redactBoth(`leaked ${short} here`), "leaked [REDACTED] here");
  assert.ok(!redactBoth(`x${long}y`).includes("1234567890"));
});

test("masks Bearer credentials but keeps the scheme", () => {
  const redact = makeRedactor({});
  assert.equal(
    redact(`Authorization: ${FAKE_BEARER}`),
    "Authorization: Bearer [REDACTED]",
  );
  // Multiple credentials on one line are all masked.
  assert.equal(
    redact(`${FAKE_BEARER} and ${FAKE_BEARER}`),
    "Bearer [REDACTED] and Bearer [REDACTED]",
  );
});

test("masks several key shapes in one tool-result-style blob", () => {
  const redact = makeRedactor({});
  const blob = [
    `OPENAI_KEY=${FAKE_OPENAI}`,
    `ANTHROPIC_KEY=${FAKE_ANTHROPIC}`,
    `AWS_ACCESS_KEY_ID=${FAKE_AWS}`,
    `SLACK_TOKEN=${FAKE_SLACK_BOT}`,
    `Authorization: ${FAKE_BEARER}`,
    `gh token ${FAKE_GITHUB}`,
  ].join("\n");
  const out = redact(blob);
  for (const fake of [FAKE_OPENAI, FAKE_ANTHROPIC, FAKE_AWS, FAKE_SLACK_BOT, FAKE_GITHUB, "FAKEBEARERTOKEN0123456789abcdef"]) {
    assert.ok(!out.includes(fake), `${fake} must not survive redaction`);
  }
  assert.match(out, /OPENAI_KEY=\[REDACTED\]/);
  assert.match(out, /Authorization: Bearer \[REDACTED\]/);
});

test("does not mask normal hex SHAs or short sk- fragments", () => {
  const redact = makeRedactor({});
  assert.equal(redact(`commit ${FAKE_HEX_SHA} landed`), `commit ${FAKE_HEX_SHA} landed`);
  assert.equal(redact(`commit ${FAKE_SHORT_SHA} landed`), `commit ${FAKE_SHORT_SHA} landed`);
  assert.equal(redact("see sk-short in the docs"), "see sk-short in the docs");
  assert.equal(redact("the bearer of bad news arrived"), "the bearer of bad news arrived");
  assert.equal(redact("plain text with no secrets at all"), "plain text with no secrets at all");
});

test("redactValue deep-redacts key shapes inside structured tool payloads", () => {
  const redact = makeRedactor({});
  const payload = {
    command: `curl -H "Authorization: ${FAKE_BEARER}" https://example.invalid`,
    env: { OPENAI_API_KEY: FAKE_OPENAI, AWS_ACCESS_KEY_ID: FAKE_AWS },
    nested: [{ token: FAKE_SLACK_BOT }],
    sha: FAKE_HEX_SHA,
  };
  assert.deepEqual(redactValue(payload, redact), {
    command: `curl -H "Authorization: Bearer [REDACTED]" https://example.invalid`,
    env: { OPENAI_API_KEY: "[REDACTED]", AWS_ACCESS_KEY_ID: "[REDACTED]" },
    nested: [{ token: "[REDACTED]" }],
    sha: FAKE_HEX_SHA,
  });
});

test("known env values are still masked by exact match", () => {
  const redact = makeRedactor({ MY_API_KEY: "my-super-secret-key-42" });
  assert.equal(redact("leaked my-super-secret-key-42 here"), "leaked [REDACTED] here");
});
