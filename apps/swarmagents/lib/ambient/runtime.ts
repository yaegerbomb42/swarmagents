import { checkNavigationAsync } from "../browser/policy";
import { telemetryBus } from "../telemetry/bus";
import { getRuntimeManager } from "../runtime/manager";
import { readRunReport } from "../runtime/run-report";
import { createReadReport } from "./read-report";
import { WORKSPACE_ROOT } from "../vm/files";
import { AmbientEngine, type AmbientEngineDeps } from "./engine";
import type { PostedRunReport } from "./types";

const TERMINAL = new Set(["run.finished", "run.error", "run.cancelled"]);

async function readReportWhenReady(runId: string): Promise<{ status?: string; summary?: string } | null> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const report = readRunReport(runId);
    if (report) {
      const summary = report.finalText?.slice(0, 500) || report.couldNotDo[0] || `Run report ${report.status}`;
      return { status: report.status, summary };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

function productionDeps(): AmbientEngineDeps {
  const runtime = getRuntimeManager();
  return {
    ensureVm: async (userId) => {
      await runtime.vmManager.ensure(userId);
    },
    startRun: (userId, input) => runtime.start(userId, input),
    statFile: async (userId, filePath) => {
      const state = await runtime.vmManager.status(userId);
      if (state.status !== "running") return null;
      let stdout = "";
      const target = `${WORKSPACE_ROOT}/${filePath}`;
      const result = await runtime.vmManager.exec(userId, ["stat", "-c", "%Y", target], {
        timeoutMs: 10_000,
        onStdout: (chunk) => {
          stdout += chunk;
        },
      });
      if (result.exitCode !== 0) return null;
      const seconds = Number(stdout.trim());
      return Number.isFinite(seconds) ? seconds * 1000 : null;
    },
    githubCi: async (repo, pr) => {
      const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
      if (!token) return null;
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "swarmagents-ambient",
      };
      const pull = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}`, { headers });
      if (!pull.ok) return null;
      const body = (await pull.json()) as { head?: { sha?: string } };
      const sha = body.head?.sha;
      if (!sha) return null;
      const checks = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}/check-runs?per_page=100`, { headers });
      if (!checks.ok) return { sha, failed: false };
      const payload = (await checks.json()) as { check_runs?: { conclusion?: string | null }[] };
      const failed = (payload.check_runs ?? []).some((run) => run.conclusion === "failure");
      return { sha, failed };
    },
    readReport: createReadReport(readRunReport),
    post: async (entry) => {
      const { appendDelivery } = await import("./store");
      appendDelivery(entry);
      await deliverRemote(entry);
    },
    onTerminal: (runId, listener) =>
      telemetryBus.subscribe(runId, 0, (event) => {
        if (!TERMINAL.has(event.type)) return;
        void readReportWhenReady(runId).then(() => listener(event.type));
      }),
  };
}

const MAX_DELIVERY_HOPS = 3;

export type RemoteDeliveryResult = "delivered" | "blocked";

/**
 * POST a webhook body only after each hop passes checkNavigationAsync.
 * Redirects are followed manually so a public URL cannot bounce to loopback,
 * link-local, or private addresses. http:// is refused (https only).
 */
export async function dispatchRemoteDelivery(
  url: string,
  body: string,
  options?: {
    fetchImpl?: typeof fetch;
    lookup?: (host: string) => Promise<string[]>;
  },
): Promise<RemoteDeliveryResult> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  let current = url;
  for (let hop = 0; hop <= MAX_DELIVERY_HOPS; hop++) {
    if (!/^https:\/\//i.test(current)) return "blocked";
    const verdict = await checkNavigationAsync(current, options?.lookup);
    if (!verdict.ok) return "blocked";
    let response: Response;
    try {
      response = await fetchImpl(verdict.url, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json" },
        body,
      });
    } catch {
      return "blocked";
    }
    if (response.status < 300 || response.status >= 400) return "delivered";
    const location = response.headers.get("location");
    if (!location) return "blocked";
    try {
      current = new URL(location, verdict.url).toString();
    } catch {
      return "blocked";
    }
  }
  return "blocked";
}

async function deliverRemote(entry: PostedRunReport): Promise<void> {
  const { getRule } = await import("./store");
  const rule = getRule(entry.userId, entry.ruleId);
  const url = rule?.delivery?.url;
  if (!url) return;
  await dispatchRemoteDelivery(url, JSON.stringify(entry));
}

let engine: AmbientEngine | null = null;
let timer: NodeJS.Timeout | null = null;

export function getAmbientEngine(): AmbientEngine {
  if (!engine) engine = new AmbientEngine(productionDeps());
  return engine;
}

export function setAmbientEngineForTesting(next: AmbientEngine | null): void {
  engine = next;
}

/** Poll cron, file, and GitHub CI triggers. Webhooks arrive on their own route. */
export function startAmbientWatchers(intervalMs = 60_000): void {
  if (timer) return;
  const tick = () => {
    const current = getAmbientEngine();
    void current.tickCron().catch((error) => console.error("[ambient] cron", error));
    void current.tickFiles().catch((error) => console.error("[ambient] file", error));
    void current.tickGithub().catch((error) => console.error("[ambient] github", error));
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
}
