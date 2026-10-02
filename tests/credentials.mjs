// The sign-up form and /api/signup must agree on every password: both use lib/credentials.ts.
// Run: npx tsx tests/credentials.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { passwordChecks, signupCredentialsError, newPasswordError, passwordLengthError } from "../lib/credentials.ts";
import { validateCredentials } from "../lib/users.ts";

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log("ok -", name); };

const samples = ["short1A!", "alllowercase-123", "ALLUPPER-123", "NoDigits-here", "NoSymbol1234x", "Good-pass-123", "Ünïcode-Pass1", "  Spaces 1aA ", "x".repeat(300) + "A1!", "Correct-Horse-9"];

t("the form's checklist and the server agree on every sample", () => {
  for (const pw of samples) {
    const formOk = passwordChecks(pw).every((c) => c.ok);
    assert.equal(validateCredentials("alice", pw) === null, formOk, pw);
    assert.equal(signupCredentialsError("alice", pw) === null, formOk, pw);
  }
});

t("a new password needs 10+ chars and upper, lower, number and symbol", () => {
  assert.equal(newPasswordError("Good-pass-123"), null);
  assert.match(newPasswordError("good-pass-123"), /uppercase/);
  assert.match(newPasswordError("GOOD-PASS-123"), /lowercase/);
  assert.match(newPasswordError("Good-pass-abc"), /number/);
  assert.match(newPasswordError("Goodpass1234"), /symbol/);
  assert.match(newPasswordError("Aa1!"), /at least 10/);
});

t("the boot-seeded admin is checked for length only, so an existing admin password still works", () => {
  assert.equal(validateCredentials("admin", "plainlowercase", { lengthOnly: true }), null);
  assert.equal(passwordLengthError("short"), "Password must be at least 10 characters.");
});

t("usernames: 3–32 of letters, digits, dot, dash, underscore", () => {
  assert.equal(validateCredentials("al", "Good-pass-123") !== null, true);
  assert.equal(validateCredentials("a@b.com", "Good-pass-123") !== null, true);
  assert.equal(validateCredentials("al.ice_2-x", "Good-pass-123"), null);
});

t("the login page uses the shared rules, not its own copy", () => {
  const src = fs.readFileSync(new URL("../app/login/page.tsx", import.meta.url), "utf8");
  assert.match(src, /from "@\/lib\/credentials"/);
  assert.doesNotMatch(src, /\/\[A-Z\]\/\.test|\/\[0-9\]\/\.test/, "no re-implemented password regexes in the form");
});

console.log(`\n${pass} passed`);
