/** F14 ambient watcher: a persistent-VM trigger that starts a role run. */

export type AmbientTriggerKind = "cron" | "webhook" | "file" | "github_pr_ci";

export interface AmbientDelivery {
  /** Append the Run Report to the local delivery log. */
  kind: "log";
  /** Optional HTTPS endpoint that also receives the posted report. */
  url?: string;
}

export interface AmbientRule {
  id: string;
  userId: string;
  roleId: string;
  /** Prompt handed to the role when the trigger fires. */
  prompt: string;
  /** Exact PreToolUse tool names. Empty denies every tool. */
  toolAllowlist: string[];
  enabled: boolean;
  kind: AmbientTriggerKind;
  /** Five-field cron. Evaluated in `timezone` or UTC. */
  cron?: string;
  timezone?: string;
  /** Shared secret required on POST /api/hooks/<userId>/<id>. */
  webhookSecret?: string;
  /** Workspace-relative path watched inside the user's VM. */
  filePath?: string;
  /** Last observed mtime ms for the watched file. */
  fileMtimeMs?: number;
  /** owner/repo */
  githubRepo?: string;
  githubPr?: number;
  /** Head SHA already fired for, so one red CI run wakes the VM once. */
  githubFiredSha?: string;
  delivery?: AmbientDelivery;
  /** Minute bucket already fired, so a cron match is once per minute. */
  lastCronBucket?: string;
}

export interface PostedRunReport {
  ruleId: string;
  userId: string;
  runId: string;
  postedAt: number;
  status: string;
  /** Short receipt. The full report stays in the run-report store. */
  summary: string;
  reportFound: boolean;
}

export interface FireResult {
  fired: boolean;
  runId?: string;
  queued?: boolean;
  error?: string;
}
