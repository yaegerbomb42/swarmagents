import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://swarmagents.codes"),
  // Plain string, not a template: several pages already hardcode their own
  // "— SwarmAgents" suffix, and a template would double it.
  title: "SwarmAgents — Give it a task. It has its own computer.",
  description:
    "One chat bar. One agent. Every tool. Nothing hidden. SwarmAgents runs one autonomous agent in your own persistent Linux VM — watch every step live, take over anytime. Free; bring your own model keys.",
  openGraph: {
    title: "SwarmAgents — Give it a task. It has its own computer.",
    description:
      "One chat bar. One agent. Every tool. Nothing hidden. Your agent works in its own Linux VM while you watch, steer, or take over. Free and open source.",
    siteName: "SwarmAgents",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "SwarmAgents — Give it a task. It has its own computer.",
    description:
      "One chat bar. One agent. Every tool. Nothing hidden. Free and open source — bring your own model keys.",
  },
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
