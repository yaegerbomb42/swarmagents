"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getToken } from "@/lib/auth";

export default function LandingAuthCtas({ variant }: { variant?: "hero" | "nav" }) {
  const [authed, setAuthed] = useState(false);
  useEffect(() => {
    setAuthed(Boolean(getToken()));
  }, []);

  if (variant === "hero") {
    return (
      <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
        <Link
          href={authed ? "/decomp" : "/signup?next=/decomp"}
          className="inline-flex items-center justify-center px-6 py-3 rounded-lg bg-white text-black text-[15px] font-medium tracking-[-0.02em] hover:bg-zinc-200 transition-colors"
        >
          {authed ? "Open console" : "Start a mission"}
        </Link>
        {!authed && (
          <Link
            href="/login?next=/decomp"
            className="inline-flex items-center justify-center px-5 py-3 text-[15px] text-[#a1a1aa] hover:text-white transition-colors"
          >
            Sign in
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {authed ? (
        <Link href="/decomp" className="text-sm text-[#a1a1aa] hover:text-white px-3 py-1.5">
          Console
        </Link>
      ) : (
        <>
          <Link href="/login?next=/decomp" className="text-sm text-[#a1a1aa] hover:text-white px-3 py-1.5">
            Sign in
          </Link>
          <Link
            href="/signup?next=/decomp"
            className="text-sm px-3 py-1.5 rounded-md bg-white text-black font-medium"
          >
            Get started
          </Link>
        </>
      )}
    </div>
  );
}
