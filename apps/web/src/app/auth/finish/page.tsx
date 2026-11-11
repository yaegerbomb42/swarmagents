"use client";

import React, { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  completeSignInWithEmailLink,
  isEmailLinkAuthFlow,
  postAuthPath,
} from "@/lib/auth";

function FinishInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = postAuthPath(params.get("next"));
  const [status, setStatus] = useState<"checking" | "need_email" | "signing_in" | "error">("checking");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const tryComplete = async (override?: string) => {
    setStatus("signing_in");
    setError(null);
    const res = await completeSignInWithEmailLink(override);
    if (res.ok === true) {
      router.replace(next);
      return;
    }
    setError(res.error.error);
    // If the error is "email required" (different device) prompt for it.
    if (res.error.code === "email_required") {
      setStatus("need_email");
    } else {
      setStatus("error");
    }
  };

  useEffect(() => {
    if (!isEmailLinkAuthFlow()) {
      setError("This link is invalid or has expired. Request a new sign-in link.");
      setStatus("error");
      return;
    }
    void tryComplete();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === "checking" || status === "signing_in") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#050508]">
        <div className="text-cyan-200">Signing you in…</div>
      </main>
    );
  }

  if (status === "need_email") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#050508] px-6">
        <form
          className="w-full max-w-sm rounded-lg border border-cyan-500/20 bg-black/50 p-6"
          onSubmit={(e) => {
            e.preventDefault();
            void tryComplete(email);
          }}
        >
          <h1 className="mb-2 text-lg font-semibold text-cyan-100">Confirm your email</h1>
          <p className="mb-4 text-sm text-cyan-100/60">
            You opened this link on a different device. Enter the email address the link was sent to.
          </p>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full rounded-md border border-cyan-500/30 bg-black/60 px-3 py-2 text-cyan-100 placeholder:text-cyan-100/30 focus:border-cyan-400 focus:outline-none"
          />
          <button
            type="submit"
            className="mt-4 w-full rounded-md bg-cyan-500 py-2 text-sm font-semibold text-black hover:bg-cyan-400"
          >
            Complete sign-in
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#050508] px-6">
      <div className="w-full max-w-md rounded-lg border border-red-500/40 bg-red-950/20 p-6 text-red-200">
        <h1 className="mb-2 text-lg font-semibold">Sign-in failed</h1>
        <p className="mb-4 text-sm">{error}</p>
        <Link href="/login" className="text-sm text-cyan-300 underline">
          Back to sign-in
        </Link>
      </div>
    </main>
  );
}

export default function FinishPage() {
  return (
    <Suspense fallback={
      <main className="flex min-h-screen items-center justify-center bg-[#050508]">
        <div className="text-cyan-200">Signing you in…</div>
      </main>
    }>
      <FinishInner />
    </Suspense>
  );
}
