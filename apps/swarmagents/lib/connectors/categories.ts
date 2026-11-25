/**
 * Connector category taxonomy — pure data, no server imports, so client
 * components can import it without pulling the library catalog (and its
 * Node-only user-store) into the browser bundle.
 */

export type ConnectorCategory =
  | "code-cloud"
  | "search-data"
  | "apps-productivity"
  | "design-files"
  | "productivity"
  | "devops";

export const CONNECTOR_CATEGORIES: ReadonlyArray<{ id: "all" | ConnectorCategory; label: string }> = [
  { id: "all", label: "All" },
  { id: "code-cloud", label: "Code & Cloud" },
  { id: "search-data", label: "Search & Data" },
  { id: "apps-productivity", label: "Apps & Productivity" },
  { id: "design-files", label: "Design & Files" },
  { id: "productivity", label: "Productivity" },
  { id: "devops", label: "DevOps & Infra" },
];
