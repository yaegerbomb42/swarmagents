export type VmDriverName = "docker" | "fake" | "byoc";

/** Real execution is the production default; simulation must be explicit. */
export function defaultDriverName(env: Readonly<Record<string, string | undefined>> = process.env): VmDriverName {
  return env.NODE_ENV === "production" ? "docker" : "fake";
}
