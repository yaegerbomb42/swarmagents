import "./globals.css";
import "../components/agent-icons.css";
import type { Metadata, Viewport } from "next";

// Icons come from the app-dir conventions: app/favicon.ico (16/32/48), app/icon.png (512), app/apple-icon.png (180),
// app/manifest.ts. Artwork and variants live in public/brand.
export const metadata: Metadata = {
  title: { default: "SwarmAgents", template: "%s · SwarmAgents" },
  description: "One agent. Every tool. Nothing hidden.",
  applicationName: "SwarmAgents",
  appleWebApp: { title: "SwarmAgents", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbfa" },
    { media: "(prefers-color-scheme: dark)", color: "#111110" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
