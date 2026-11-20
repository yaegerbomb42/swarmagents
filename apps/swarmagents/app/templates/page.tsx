import type { Metadata } from "next";
import { TemplatesPageClient } from "./templates-page-client";

export const metadata: Metadata = {
  title: "Templates — SwarmAgents",
  description:
    "60 ready-made task templates with written-out prompts, variable forms and the right role for each one.",
};

// The gallery is a client component (search, filters and a drawer); the page
// itself is static content.
export const dynamic = "force-dynamic";

export default function TemplatesPage() {
  return <TemplatesPageClient />;
}
