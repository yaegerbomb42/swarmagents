import { ProvidersPage } from "@/components/ProvidersPage";

export default function ProvidersRoute() {
  return <ProvidersPage />;
}

// Fetched server-side state (provider catalog + configured keys) is per-request.
export const dynamic = "force-dynamic";
