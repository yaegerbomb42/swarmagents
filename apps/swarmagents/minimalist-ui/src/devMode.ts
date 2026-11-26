/**
 * Dev mode gates the Board panel. The board is internal build tooling, not a
 * product feature, so it stays hidden unless dev mode is on. Dev mode is a
 * per-browser flag: ?dev=1 turns it on (persisted), ?dev=0 turns it off.
 * With no parameter the stored value wins, so the flag survives reloads.
 */
export function devModeFromSearch(search: string, stored: boolean): boolean {
  const param = new URLSearchParams(search).get("dev");
  if (param === "1") return true;
  if (param === "0") return false;
  return stored;
}
