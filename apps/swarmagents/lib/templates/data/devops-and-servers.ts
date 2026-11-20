import type { TaskTemplate } from "../types";

/** Category: devops and servers. */
export const DEVOPS_AND_SERVERS: TaskTemplate[] = [
  {
    id: "set-up-a-server",
    category: "devops-and-servers",
    title: "Set up a server from scratch",
    pitch: "A hardened server with a user, a firewall, SSH keys and unattended security updates.",
    prompt:
      "Set up the server at {{host}} as a production host for {{service}}.\n\n" +
      "Steps:\n" +
      "1. Create a non-root deploy user with a locked password and a home directory.\n" +
      "2. Install and configure a firewall: only {{open_ports}} are open, everything else is dropped.\n" +
      "3. Set up SSH key-only login for that user and disable password login and root login.\n" +
      "4. Enable unattended security updates and a nightly log rotation.\n" +
      "5. Install the basics: {{base_packages}}.\n" +
      "6. Write a short provisioning script at {{script_path}} that does all of the above, so the setup can be repeated.\n\n" +
      "Show me the script and the output of the checks that prove each step worked.",
    fields: [
      { name: "host", label: "Server host", type: "text", default: "root@203.0.113.10" },
      { name: "service", label: "What the server runs", type: "text", default: "a Node API" },
      { name: "open_ports", label: "Ports to leave open", type: "text", default: "22, 80, 443" },
      { name: "base_packages", label: "Packages to install", type: "text", default: "curl, git, build-essential, ufw" },
      { name: "script_path", label: "Where to write the provisioning script", type: "text", default: "/workspace/provision.sh" },
    ],
    role: "devops",
    estimatedMinutes: 25,
    tools: ["bash", "write_file", "read_file"],
    mcp: [],
    example:
      "provision.sh — idempotent: ufw default deny incoming, allow 22/80/443, SSH PasswordAuthentication no, PermitRootLogin no, unattended-upgrades enabled, logrotate nightly.\n" +
      "Checks:\n" +
      "  ufw status: '22/tcp ALLOW, 80/tcp ALLOW, 443/tcp ALLOW, everything else DROP'\n" +
      "  sshd -T | grep passwordauth: 'passwordauthentication no'\n" +
      "  systemctl is-enabled unattended-upgrades: 'enabled'\n" +
      "The deploy user 'deploy' exists with a locked password and one authorised key.",
  },
  {
    id: "write-a-deploy-script",
    category: "devops-and-servers",
    title: "Write a deploy script",
    pitch: "One command that builds, tests, releases and rolls back if the health check fails.",
    prompt:
      "Write a deploy script at {{script_path}} for the app in {{directory}} that deploys to {{target}}.\n\n" +
      "Requirements:\n" +
      "- The script runs the build and the tests before anything is deployed, and stops on the first failure.\n" +
      "- It makes a backup or a snapshot of the current release, then swaps the new release in.\n" +
      "- It waits for the health check at {{health_path}} to pass, with a timeout of {{timeout_seconds}} seconds.\n" +
      "- If the health check does not pass, it rolls back to the previous release automatically and exits non-zero with the reason.\n" +
      "- It is safe to run twice: running it again with no changes is a no-op that says so.\n" +
      "- No secrets in the script: read them from the environment or from {{secret_source}}.\n\n" +
      "Run the script against a test target and show me the output.",
    fields: [
      { name: "script_path", label: "Script path", type: "text", default: "/workspace/deploy.sh" },
      { name: "directory", label: "App directory", type: "text", default: "/workspace/app" },
      { name: "target", label: "Deploy target", type: "text", default: "a systemd service on this machine" },
      { name: "health_path", label: "Health check path", type: "text", default: "/health" },
      { name: "timeout_seconds", label: "Health check timeout (seconds)", type: "text", default: "30" },
      { name: "secret_source", label: "Where secrets come from", type: "select", options: ["environment variables", "a secrets file on disk", "the system keyring"], default: "environment variables" },
    ],
    role: "deployer",
    estimatedMinutes: 25,
    tools: ["write_file", "bash", "edit_file"],
    mcp: [],
    example:
      "deploy.sh — build → test → snapshot current release → swap symlink → systemctl restart → poll /health for 30s → on failure restore the previous symlink, restart, exit 1 with the failing curl output.\n" +
      "Re-running with no code change: 'no changes since release 41, nothing to do' (exit 0).\n" +
      "Secrets come from the environment; the script contains no key material.",
  },
  {
    id: "diagnose-a-server-problem",
    category: "devops-and-servers",
    title: "Diagnose a server problem",
    pitch: "The service is down; you find why with real output, not guesses.",
    prompt:
      "The service {{service_name}} on this machine is not working. This is what I see:\n{{symptoms}}\n\n" +
      "Diagnose it properly:\n" +
      "1. Check whether it is running, and read its logs and the system logs around the failure.\n" +
      "2. Check the things that usually explain it: listening ports, disk space, memory, the config file, the certificate, the upstream it talks to.\n" +
      "3. Form one hypothesis and test it. If it is wrong, say so and form another.\n" +
      "4. Fix the cause, then restart the service and prove it is healthy.\n\n" +
      "Report the root cause in one sentence, the evidence, the fix, and the proof it works now.",
    fields: [
      { name: "service_name", label: "Service", type: "text", default: "swarmagents" },
      { name: "symptoms", label: "What you see", type: "textarea", default: "curl to the health endpoint times out, and the service is in 'activating' state" },
    ],
    role: "devops",
    estimatedMinutes: 25,
    tools: ["bash", "read_file", "write_file"],
    mcp: [],
    example:
      "Root cause: the service was reading its port from the config file, the config file was overwritten by the deploy and no longer had a 'port' key, so it bound to 0 and exited.\n" +
      "Evidence: journalctl showed 'listen: missing port in config'; ss showed nothing on 3000; the deploy snapshot from 09:12 had the key.\n" +
      "Fix: restored the key in config, restarted.\n" +
      "Proof now: systemctl is-active -> active; curl /health -> {\"status\":\"ok\"}.",
  },
  {
    id: "monitor-a-service",
    category: "devops-and-servers",
    title: "Set up monitoring for a service",
    pitch: "A health check that runs on a schedule, records the result and tells you when it breaks.",
    prompt:
      "Set up monitoring for {{service}} in {{directory}}.\n\n" +
      "Requirements:\n" +
      "- A check that runs every {{interval_seconds}} seconds and probes {{check_command}}.\n" +
      "- Every result is appended as one JSON line to {{log_path}}: timestamp, ok/failed, duration in ms, and the output (truncated to {{max_output_bytes}} bytes).\n" +
      "- A summary that reports the success rate and the p95 duration over the last {{window_minutes}} minutes.\n" +
      "- An alert that fires when {{failure_threshold}} consecutive checks fail: it writes to {{alert_path}} and, if {{slack_webhook_env}} is set, posts a message there.\n" +
      "- No secrets in the logs: the webhook URL is read from the environment, never written to disk.\n\n" +
      "Run it for a few cycles and show me the log and the summary.",
    fields: [
      { name: "service", label: "Service to monitor", type: "text", default: "the web API on port 3000" },
      { name: "directory", label: "Working directory", type: "text", default: "/workspace" },
      { name: "interval_seconds", label: "Check interval (seconds)", type: "text", default: "60" },
      { name: "check_command", label: "The check", type: "text", default: "curl -fsS http://127.0.0.1:3000/health" },
      { name: "log_path", label: "Log file", type: "text", default: "/workspace/monitor/checks.jsonl" },
      { name: "max_output_bytes", label: "Output to keep per check (bytes)", type: "text", default: "2048" },
      { name: "window_minutes", label: "Summary window (minutes)", type: "text", default: "60" },
      { name: "failure_threshold", label: "Consecutive failures before alerting", type: "text", default: "3" },
      { name: "alert_path", label: "Where to write local alerts", type: "text", default: "/workspace/monitor/alerts.log" },
      { name: "slack_webhook_env", label: "Env var holding the webhook URL", type: "text", default: "SLACK_WEBHOOK_URL" },
    ],
    role: "devops",
    estimatedMinutes: 20,
    tools: ["write_file", "bash", "read_file"],
    mcp: [],
    example:
      "monitor/check.sh + monitor/summary.sh.\n" +
      "checks.jsonl lines look like: {\"ts\":\"2026-11-12T10:04:21Z\",\"ok\":true,\"duration_ms\":18,\"output\":\"{\\\"status\\\":\\\"ok\\\"}\"}\n" +
      "Summary over the last 60 minutes: 42 checks, 100% success, p95 24ms.\n" +
      "Alert path: after 3 consecutive failures it appends to alerts.log and posts to $SLACK_WEBHOOK_URL. The URL is read from the environment and never written to a file or a log line.",
  },
  {
    id: "backup-and-restore",
    category: "devops-and-servers",
    title: "Write a backup and restore script",
    pitch: "A backup you can prove restores, and a restore you can actually run.",
    prompt:
      "Write backup and restore scripts for {{what}} in {{directory}}.\n\n" +
      "Requirements:\n" +
      "- backup.sh creates a timestamped, compressed archive of {{source_path}} in {{backup_dir}}, and keeps the last {{keep_count}} archives.\n" +
      "- restore.sh takes an archive and restores it to {{restore_target}}, asking for confirmation before overwriting anything.\n" +
      "- Both scripts verify their own work: the backup checks the archive is readable and lists its contents; the restore verifies the restored files match the archive.\n" +
      "- Backups never include {{excluded}} and never contain credentials.\n" +
      "- A checksum file sits next to each archive so corruption is detectable.\n\n" +
      "Run a backup, then restore it into a scratch directory, and show me both outputs.",
    fields: [
      { name: "what", label: "What is being backed up", type: "text", default: "the Postgres database and the uploaded files" },
      { name: "directory", label: "Working directory", type: "text", default: "/workspace" },
      { name: "source_path", label: "Source path", type: "text", default: "/var/lib/postgresql/data" },
      { name: "backup_dir", label: "Backup directory", type: "text", default: "/workspace/backups" },
      { name: "keep_count", label: "How many archives to keep", type: "text", default: "7" },
      { name: "restore_target", label: "Where restore puts things", type: "text", default: "/workspace/restore-test" },
      { name: "excluded", label: "What to exclude", type: "text", default: "*.tmp and node_modules" },
    ],
    role: "devops",
    estimatedMinutes: 20,
    tools: ["write_file", "bash", "read_file"],
    mcp: [],
    example:
      "backup.sh — tar czf backups/app-2026-11-12T101500Z.tar.gz /var/lib/postgresql/data, plus sha256 next to it, prunes to the 7 newest, verifies with 'tar tzf' and prints the entry count.\n" +
      "restore.sh — 'restoring will overwrite /workspace/restore-test, continue? [y/N]', extracts, then diffs the extracted tree against the archive listing.\n" +
      "Test run: archive 128,441,902 bytes, 214 entries; restore into restore-test matched exactly.",
  },
  {
    id: "harden-an-api",
    category: "devops-and-servers",
    title: "Harden an API server",
    pitch: "Body caps, timeouts, header limits and a rate limit — the boring things that stop real attacks.",
    prompt:
      "Harden the API server in {{directory}} against the abuse it is exposed to.\n\n" +
      "Apply all of these:\n" +
      "- A maximum request body of {{body_limit_bytes}} bytes, rejected with 413 before the body is read into memory.\n" +
      "- A request timeout of {{timeout_seconds}} seconds and a response header timeout, so a slow client cannot hold a connection open.\n" +
      "- A limit on the request header size and count.\n" +
      "- A rate limit of {{rate_limit}} requests per minute per client, with 429 and Retry-After.\n" +
      "- CORS restricted to {{allowed_origins}}, and the security headers from the project's existing helper if there is one.\n" +
      "- Secrets read from the environment; no default password anywhere in the code.\n\n" +
      "Write a test for each limit and show me the test output. Keep the existing behaviour for valid requests.",
    fields: [
      { name: "directory", label: "Project directory", type: "text", default: "/workspace/api" },
      { name: "body_limit_bytes", label: "Max body size (bytes)", type: "text", default: "1048576" },
      { name: "timeout_seconds", label: "Request timeout (seconds)", type: "text", default: "30" },
      { name: "rate_limit", label: "Requests per minute per client", type: "text", default: "120" },
      { name: "allowed_origins", label: "Allowed origins", type: "text", default: "https://app.example.com" },
    ],
    role: "security-auditor",
    estimatedMinutes: 25,
    tools: ["read_file", "edit_file", "write_file", "bash"],
    mcp: [],
    example:
      "Applied to src/server.ts:\n" +
      "  body limit 1 MiB -> 413 (checked before reading the body)\n" +
      "  request timeout 30s, headers timeout 15s, max header size 16 KiB\n" +
      "  rate limit 120/min per IP -> 429 + Retry-After\n" +
      "  CORS: only https://app.example.com\n" +
      "Tests: 8 new (oversized body, slow body, too many headers, over limit, disallowed origin, valid request still 200). Suite: 47 passing.",
  },
  {
    id: "migrate-a-service-to-docker",
    category: "devops-and-servers",
    title: "Move a running service into Docker",
    pitch: "The same service, now in a container, with the data on a volume and the healthcheck green.",
    prompt:
      "Move {{service}} into Docker. It currently runs on the host at {{host_service}}.\n\n" +
      "Requirements:\n" +
      "- A Dockerfile that reproduces the current runtime exactly, including the version of every runtime dependency.\n" +
      "- The service keeps its data in a named volume, not inside the image.\n" +
      "- The container runs as a non-root user, restarts unless stopped, and has a healthcheck that matches the existing health endpoint.\n" +
      "- Ports and environment variables are documented in a .env.example — names only, no values.\n" +
      "- A compose file that starts it, and a short runbook at {{runbook_path}} with the everyday commands: start, stop, logs, restore.\n\n" +
      "Bring the container up and show me it is healthy and serving.",
    fields: [
      { name: "service", label: "Service", type: "text", default: "the orders API" },
      { name: "host_service", label: "How it runs today", type: "text", default: "a systemd unit on port 3000" },
      { name: "runbook_path", label: "Where to write the runbook", type: "text", default: "/workspace/RUNBOOK.md" },
    ],
    role: "devops",
    estimatedMinutes: 30,
    tools: ["bash", "write_file", "read_file", "edit_file"],
    mcp: [],
    example:
      "Dockerfile — node:22-bookworm, deps pinned from the host's package-lock, non-root user 'app', HEALTHCHECK hits /health.\n" +
      "docker-compose.yml — service 'orders', port 3000, volume 'ordersdata' -> /var/lib/orders, env from .env (names only in .env.example).\n" +
      "RUNBOOK.md — up/down/logs/backup/restore commands.\n" +
      "Container up: STATUS 'healthy', curl http://127.0.0.1:3000/health -> {\"status\":\"ok\"}.",
  },
  {
    id: "trace-a-slow-request",
    category: "devops-and-servers",
    title: "Trace a slow request",
    pitch: "One slow request explained down to the query or the upstream that caused it.",
    prompt:
      "The endpoint {{endpoint}} is slow — about {{observed_latency}} per request. Find out why.\n\n" +
      "Steps:\n" +
      "1. Reproduce it and measure it yourself. Record the exact command and the timing.\n" +
      "2. Break the time down: how much is the handler, the database, and the upstream call? Measure each part, do not guess.\n" +
      "3. Identify the specific slow operation and quote the measurement that shows it.\n" +
      "4. Fix it if the fix is safe and local. If the real fix is architectural, say so, and still do the safe local improvement.\n" +
      "5. Re-measure and report before and after.\n\n" +
      "Write the analysis to {{output_path}}.",
    fields: [
      { name: "endpoint", label: "Slow endpoint", type: "text", default: "GET /api/reports/summary" },
      { name: "observed_latency", label: "Observed latency", type: "text", default: "3.8s" },
      { name: "output_path", label: "Where to write the analysis", type: "text", default: "/workspace/perf/report.md" },
    ],
    role: "devops",
    estimatedMinutes: 30,
    tools: ["bash", "read_file", "edit_file", "write_file"],
    mcp: [],
    example:
      "# Slow request: GET /api/reports/summary\n\n" +
      "Reproduced: curl -w '%{time_total}' -> 3.91s (median of 5).\n" +
      "Breakdown: handler 4ms, Postgres 3,780ms, upstream 12ms.\n" +
      "The slow operation is the summary query — a sequential scan on orders.customer_id with no index (EXPLAIN: 'Seq Scan on orders', 3,700ms).\n" +
      "Fix: added index orders(customer_id); re-measured 61ms total, query 44ms.\n" +
      "The deeper issue — the endpoint computes the summary by scanning the whole table on every request — would need a materialised view; not done here.",
  },
];
