/**
 * Tests for the login form's keyboard accessibility (p6).
 *
 * The suite runs on node:test with no DOM, so the component is checked with
 * a static render (`renderToStaticMarkup`): every tab stop must render
 * inside the `.login-form` container, which is the selector the stylesheet
 * uses for the focus ring. The CSS rule itself and the absence of an inline
 * outline suppression (the original bug) are pinned by reading the sources.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LoginForm from "./login-form";

const css = (): string => readFileSync(new URL("../globals.css", import.meta.url), "utf8");
const formSource = (): string => readFileSync(new URL("./login-form.tsx", import.meta.url), "utf8");

function renderSignup(): string {
  return renderToStaticMarkup(React.createElement(LoginForm, { next: "/app", allowSignup: true }));
}

function renderSignin(): string {
  return renderToStaticMarkup(React.createElement(LoginForm, { next: "/app", allowSignup: false }));
}

test("every login tab stop renders inside .login-form so the focus rule applies", () => {
  const signup = renderSignup();
  assert.ok(/class="login-form"/.test(signup), "form must carry the login-form class");

  const form = signup.slice(signup.indexOf('class="login-form"'));
  for (const tabStop of [
    /<input[^>]*id="email"/,
    /<input[^>]*id="password"/,
    /<button[^>]*data-testid="password-toggle"/,
    /<button[^>]*data-testid="signup-toggle"/,
    /<button[^>]*type="submit"/,
  ]) {
    assert.match(form, tabStop, "missing tab stop inside the form");
  }

  const signin = renderSignin();
  const signinForm = signin.slice(signin.indexOf('class="login-form"'));
  assert.match(signinForm, /<button[^>]*data-testid="forgot-password-link"/);
  assert.doesNotMatch(signinForm, /data-testid="signup-toggle"/, "signup toggle hidden when signup is closed");
});

test("the stylesheet keeps an unsuppressible focus-visible ring on the login form", () => {
  assert.match(
    css(),
    /\.login-form :focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-focus\) !important/,
    "the scoped .login-form :focus-visible ring must exist and beat inline suppression",
  );
});

test("the login form never suppresses the outline inline again", () => {
  assert.doesNotMatch(formSource(), /outline:\s*["'`]?none/, "inline outline:none must not return");
});
