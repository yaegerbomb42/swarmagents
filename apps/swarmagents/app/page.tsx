import HomeClient from "./home-client";

export default function Home() {
  return <HomeClient />;
}

// Serve the shell per-request instead of from the static prerender cache:
// the CSP nonce is minted per request in middleware, so Next can only stamp it
// onto its inline bootstrap scripts when the page is rendered dynamically.
export const dynamic = "force-dynamic";