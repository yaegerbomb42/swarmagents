/**
 * Per-lane compute placement for one Team Mode run.
 *
 * Local work (indexing, MLX/Ollama inference, private-repo edits) is placed on
 * a paired computer (`computer:<id>`). Browser scraping, Playwright, and
 * Docker builds stay on the cloud VM pool. Tasks with no signal stay on cloud.
 * A cloud verb wins when a single task mentions both, because those tools need
 * a VM. With only one lane and both kinds of work, the lane stays on cloud so
 * the VM-only tasks are not dropped.
 */

export type LanePlacement = "cloud" | "byoc";

const BYOC_RE = /\b(index(?:ing)?|mlx|ollama|inference|embed(?:ding)?s?|private[ -]?repo)\b/i;
const CLOUD_RE = /\b(playwright|e2e|scrap(?:e|ing)|browser|docker)\b/i;
const COMPUTER_RE = /^cmp_[a-f0-9-]{8,64}$/i;

export interface PlannedLane {
  taskIndexes: number[];
  placement: LanePlacement;
  computeTarget: string;
}

export function classifyTaskText(text: string): LanePlacement | "either" {
  const cloud = CLOUD_RE.test(text);
  const byoc = BYOC_RE.test(text);
  if (cloud) return "cloud";
  if (byoc) return "byoc";
  return "either";
}

export function partitionTeamLanes(input: {
  taskCount: number;
  texts: readonly string[];
  laneCount: number;
  byocComputerId?: string;
}): PlannedLane[] {
  const count = Math.max(0, Math.floor(input.taskCount));
  const laneCount = Math.max(1, Math.floor(input.laneCount));
  const computer = input.byocComputerId?.trim() ?? "";
  const paired = COMPUTER_RE.test(computer) ? computer.toLowerCase() : "";
  const classes = Array.from({ length: count }, (_, index) => classifyTaskText(input.texts[index] ?? ""));
  const byocIdx = classes.flatMap((kind, index) => (kind === "byoc" ? [index] : []));
  const otherIdx = classes.flatMap((kind, index) => (kind === "byoc" ? [] : [index]));
  const reserveByoc = Boolean(paired) && byocIdx.length > 0 && (otherIdx.length === 0 || laneCount > 1);

  const lanes: PlannedLane[] = [];
  if (reserveByoc) {
    lanes.push({
      taskIndexes: byocIdx,
      placement: "byoc",
      computeTarget: `computer:${paired}`,
    });
  }

  const cloudIdx = reserveByoc ? otherIdx : [...otherIdx, ...byocIdx];
  if (cloudIdx.length === 0) return lanes;

  const budget = Math.max(1, laneCount - lanes.length);
  const width = Math.min(budget, cloudIdx.length);
  const buckets: number[][] = Array.from({ length: width }, () => []);
  cloudIdx.forEach((taskIndex, index) => {
    buckets[index % width].push(taskIndex);
  });
  for (const taskIndexes of buckets) {
    lanes.push({ taskIndexes, placement: "cloud", computeTarget: "cloud" });
  }
  return lanes;
}
