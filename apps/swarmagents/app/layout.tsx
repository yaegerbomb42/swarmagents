import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { NONCE_HEADER } from "../lib/security-headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "SwarmAgents",
  description: "One chat bar. One agent. Every tool. Nothing hidden.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Middleware mints a fresh nonce per request and forwards it to the render
  // on the x-nonce header (with the full CSP, so Next stamps it onto its own
  // inline bootstrap scripts). Reading it here keeps every route dynamic so a
  // stale nonce can never be served from a static cache, and we surface it on
  // <body> for client code to use when it injects its own inline scripts —
  // no self-fetch required.
  const nonce = (await headers()).get(NONCE_HEADER) ?? "";
  return (
    <html lang="en">
      <body data-nonce={nonce}>{children}</body>
    </html>
  );
}
