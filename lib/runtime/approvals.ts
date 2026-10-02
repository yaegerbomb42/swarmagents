// Approval gate for destructive or outward-facing tool actions.
//
// Long autonomous runs must be able to do real work unattended - but "real work" includes shell
// commands that delete data, push code, spend money or talk to the outside world. Rather than pause
// on everything, we classify a call as risky only when it clearly is, stop the run there, and surface
// one decision to the user in Activity ("Approve" / "Deny"). An approval is a one-shot grant bound to
// the exact action (tool + normalized input), so approving `rm -rf build` never approves a later
// `rm -rf ~`: the hash would differ.
//
// This module is intentionally free of tool/runtime imports so both the agent loop and the runtime
// API can use it without a cycle.

export type RiskLevel = "outward" | "destructive";

export interface Risk {
  level: RiskLevel;
  /** One-line, user-facing explanation of what will happen and why it needs a decision. */
  why: string;
}

// Shell verbs/patterns that destroy data or reach beyond the sandbox. Kept precise: false positives
// train the user to click through, which is worse than a small miss. We flag the obviously dangerous
// and let the model's own judgement cover the grey area.
const DESTRUCTIVE = [
  { re: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, why: "deletes files recursively" },
  { re: /\brm\s+-[a-z]*f/i, why: "force-deletes files" },
  { re: /\bgit\s+push\b/i, why: "pushes commits to a remote" },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|restore\s+--source)/i, why: "discards local work" },
  { re: /\b(truncate|shred|dd)\b\s/i, why: "overwrites data" },
  { re: /\bmkfs\b|\bformat\b/i, why: "formats a filesystem" },
  { re: /\b(shutdown|reboot|halt|killall|pkill)\b/i, why: "affects the running machine" },
  { re: /\b(DROP|TRUNCATE)\s+TABLE\b/i, why: "destroys database data" },
  { re: /\bsudo\b/i, why: "runs with elevated privileges" },
  // Recursively loosening or reassigning ownership of a whole tree.
  { re: /\bch(mod|own)\s+-R\b/i, why: "recursively changes permissions or ownership" },
  // Scheduling or editing system state. `systemctl status|list|show|is-active` is read-only and stays safe.
  { re: /\bcrontab\b/i, why: "changes scheduled jobs" },
  { re: /\bsystemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload)\b/i, why: "changes system services" },
  // Infrastructure teardown.
  { re: /\bterraform\s+(apply|destroy)\b/i, why: "changes real infrastructure" },
  { re: /\b(docker|podman)\s+(rm|rmi|volume\s+rm|system\s+prune)\b/i, why: "removes containers, images or volumes" },
];

// Reaching the network, spending money, or publishing. Outward actions are usually what the user
// wants a say in when they did not explicitly ask for it.
const OUTWARD = [
  { re: /\b(curl|wget)\b[^|;&]*\|\s*(ba)?sh\b/i, why: "pipes a download straight into a shell" },
  // A raw HTTP write from the shell: reads are fine, but POST/PUT/PATCH/DELETE or a request body can
  // change someone's data or spend money. -X GET and plain GETs stay ungated.
  { re: /\bcurl\b[^|;&]*(-X|--request)\s*(POST|PUT|PATCH|DELETE)\b/i, why: "sends a write request to a service" },
  { re: /\bcurl\b[^|;&]*(\s-d\s|\s--data\b|\s-F\s|\s--form\b|\s-T\s|\s--upload-file\b)/i, why: "uploads data to a service" },
  { re: /\b(gh|git)\s+(pr|release|issue)\s+create\b/i, why: "publishes to GitHub" },
  { re: /\bnpm\s+publish\b/i, why: "publishes a package" },
  { re: /\bdocker\s+push\b/i, why: "pushes an image to a registry" },
  { re: /\b(aws|gcloud|az)\s+.*\b(create|delete|put|update|terminate|deploy|set)\b/i, why: "changes cloud resources" },
  { re: /\b(kubectl|helm)\s+(apply|delete|upgrade|rollout)\b/i, why: "changes cluster state" },
  { re: /\b(vercel|netlify|fly|flyctl)\s+(deploy|--prod)\b/i, why: "deploys a site or app" },
];

/**
 * A control label from the browser's last observation that reads like it commits an action, e.g.
 * `button "Place order"`, `"Confirm & pay"`, `input "Delete account"`. Matched on the label only, so
 * ordinary links ("Read more") stay ungated.
 */
const COMMITTING_LABEL = /\b(submit|send|post|publish|confirm|place (order|bid)|buy|purchase|checkout|pay|delete|remove|deactivate|cancel (subscription|account|order)|transfer|withdraw|sign ?up|log ?in|subscribe|unsubscribe|accept|agree|apply)\b/i;

/** The shell command inside a tool input, if this call runs one. */
function shellCommand(input: Record<string, unknown>): string | null {
  const cmd = input.command ?? input.cmd ?? input.script;
  return typeof cmd === "string" ? cmd : null;
}

/**
 * Classify a tool call. Returns null when the call is ordinary and may run unattended.
 * `toolName` matches the tool spec name (e.g. "bash", "write_file", "browser").
 */
export function riskOf(toolName: string, input: Record<string, unknown>, targetLabel?: string): Risk | null {
  if (toolName === "bash" || toolName === "shell") {
    const cmd = shellCommand(input);
    if (!cmd) return null;
    for (const { re, why } of DESTRUCTIVE) if (re.test(cmd)) return { level: "destructive", why };
    for (const { re, why } of OUTWARD) {
      if (re.test(cmd)) return { level: "outward", why };
    }
    return null;
  }
  // File writes outside the working tree, or overwriting an existing file, are worth a look only when
  // the model is deleting: a plain write is cheap to undo. Deletion is the irreversible one.
  if (toolName === "delete_file" || toolName === "remove_file") {
    return { level: "destructive", why: "deletes a file" };
  }
  // Calling a service's API is fine for reads; a write can change the user's data or spend money.
  if (toolName === "api_request") {
    const method = String(input.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD" && input.service !== "list") {
      return { level: "outward", why: `${method}s to a saved service` };
    }
    return null;
  }
  if (toolName === "browser") {
    const action = typeof input.action === "string" ? input.action : "";
    // A plain click/type can be anything, so we gate the clearly committing forms: submitting a form,
    // pressing Enter/Return, or clicking a control whose observed label reads like a commit. The label
    // comes from the browser tool's last observation (browserTargetLabel) and is passed in by the caller
    // to keep this module import-free.
    if (action === "type" && input.submit === true) return { level: "outward", why: "submits a form" };
    if (action === "press" && /^(enter|return)$/i.test(String(input.key ?? ""))) {
      return { level: "outward", why: "presses Enter (may submit)" };
    }
    if (/submit|purchase|buy|checkout|send|post/i.test(action)) {
      return { level: "outward", why: `performs a web action (${action})` };
    }
    if ((action === "click" || action === "press") && targetLabel && COMMITTING_LABEL.test(targetLabel)) {
      return { level: "outward", why: `acts on a control that looks like it commits (${targetLabel})` };
    }
    return null;
  }
  if (toolName === "send_email" || toolName === "post_message") {
    return { level: "outward", why: "sends a message on your behalf" };
  }
  return null;
}

/** Stable, order-independent hash of the parts of an action that define it. */
export function actionHash(toolName: string, input: Record<string, unknown>): string {
  const cmd = shellCommand(input);
  const basis = cmd ?? JSON.stringify(sortKeys(input));
  let h = 2166136261;
  const s = `${toolName}\u0000${basis}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, val]) => [k, sortKeys(val)]),
    );
  }
  return v;
}

/** One-line description of a risky action for the Activity banner and the ledger. */
export function describe(toolName: string, input: Record<string, unknown>, risk: Risk): string {
  const cmd = shellCommand(input);
  const what = cmd ? cmd.trim().replace(/\s+/g, " ").slice(0, 160) : `${toolName} ${JSON.stringify(input).slice(0, 140)}`;
  return `${risk.level === "destructive" ? "Destructive" : "Outward-facing"} action needs approval (${risk.why}): ${what}`;
}