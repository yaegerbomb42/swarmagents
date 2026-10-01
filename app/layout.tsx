import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Swarm", description: "One agent. Every tool. Nothing hidden." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
