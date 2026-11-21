import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "SwarmAgents",
  description: "One chat bar. One agent. Every tool. Nothing hidden.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Middleware mints a fresh nonce per request and forwards it to the render
  // on the x-nonce header (with the full CSP, so Next stamps it onto its own
  // inline bootstrap scripts). Reading headers() here keeps every route dynamic so a
  // stale nonce can never be served from a static cache. The nonce is intentionally
  // NOT mirrored onto <body data-nonce> to avoid re-exposing it to attribute selectors
  // and client scripts reading document.body.dataset.nonce.
  await headers();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
