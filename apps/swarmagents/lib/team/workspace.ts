// Team Mode — per-lane workspace layout inside the user's VM.
//
// Every lane gets its own folder under /workspace/team/<runId>/<agentId>/.
// The Planner writes plan.json at the run root, each worker writes
// result.json in its own folder, the Reviewer writes review.json, and merged
// files land in /workspace/team/<runId>/merged/. Nothing is written on the
// host: these paths are executed inside the user's VM.

export function safeSegment(value: string): string {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 64);
  return cleaned || "unnamed";
}

export function teamRoot(runId: string): string {
  return `/workspace/team/${safeSegment(runId)}`;
}

export function laneDir(runId: string, agentId: string): string {
  return `${teamRoot(runId)}/${safeSegment(agentId)}`;
}

export function plannerDir(runId: string): string {
  return laneDir(runId, "planner");
}

export function reviewerDir(runId: string): string {
  return laneDir(runId, "reviewer");
}

export function mergeDir(runId: string): string {
  return `${teamRoot(runId)}/merged`;
}

export function planFile(runId: string): string {
  return `${teamRoot(runId)}/plan.json`;
}

export function resultFile(runId: string, agentId: string): string {
  return `${laneDir(runId, agentId)}/result.json`;
}

export function reviewFile(runId: string): string {
  return `${reviewerDir(runId)}/review.json`;
}

/** Display path: strip the /workspace prefix for the lane header. */
export function displayPath(fullPath: string): string {
  return fullPath.startsWith("/workspace/") ? fullPath.slice("/workspace/".length) : fullPath;
}