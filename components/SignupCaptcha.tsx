"use client";
// Sign-up human check (deploy lane, Jimmy 23:14): the self-hosted ALTCHA proof-of-work widget. It fetches a signed
// challenge from GET /api/signup, solves it in a Web Worker (about a second, no puzzle, no third party, no cookies)
// and hands the payload to the form, which sends it as `altcha` with the sign-up. lib/tenant/captcha.ts verifies it.
// Styled with the login page's tokens. Remount it (change `key`) to get a fresh challenge after a failed sign-up.
import { createElement, useEffect, useRef, useState } from "react";

type Detail = { state?: string; payload?: string };

export function SignupCaptcha({ onChange }: { onChange: (payload: string | null) => void }) {
  const ref = useRef<HTMLElement | null>(null);
  const [ready, setReady] = useState(false);
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    let alive = true;
    import("altcha").then(
      () => alive && setReady(true),
      () => alive && setReady(true),
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!ready || !el) return;
    const onState = (e: Event) => {
      const d = (e as CustomEvent<Detail>).detail ?? {};
      cb.current(d.state === "verified" && d.payload ? d.payload : null);
    };
    el.addEventListener("statechange", onState);
    return () => el.removeEventListener("statechange", onState);
  }, [ready]);

  return (
    <div className="signup-captcha">
      {ready ? (
        createElement("altcha-widget", {
          ref,
          challenge: "/api/signup",
          name: "altcha",
          auto: "onload",
          type: "checkbox",
          configuration: JSON.stringify({ hideFooter: true, hideLogo: false, minDuration: 400 }),
        })
      ) : (
        <div className="signup-captcha-placeholder">Loading the human check…</div>
      )}
    </div>
  );
}
