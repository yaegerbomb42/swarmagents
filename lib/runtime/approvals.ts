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
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i, why: "discards local work" },
  { re: /\b(truncate|shred|dd)\b\s/i, why: "overwrites data" },
  { re: /\bmkfs\b|\bformat\b/i, why: "formats a filesystem" },
  { re: /\b(shutdown|reboot|halt|killall|pkill)\b/i, why: "affects the running machine" },
  { re: /\b(DROP|TRUNCATE)\s+TABLE\b/i, why: "destroys database data" },
  { re: /\bsudo\b/i, why: "runs with elevated privileges" },
];

// Reaching the network, spending money, or publishing. Outward actions are usually what the user
// wants a say in when they did not explicitly ask for it.
const OUTWARD = [
  { re: /\b(curl|wget)\b[^|;&]*\|\s*(ba)?sh\b/i, why: "pipes a download straight into a shell" },
  { re: /\b(gh|git)\s+(pr|release|issue)\s+create\b/i, why: "publishes to GitHub" },
  { re: /\bnpm\s+publish\b/i, why: "publishes a package" },
  { re: /\bdocker\s+push\b/i, why: "pushes an image to a registry" },
  { re: /\baws\s+.*\b(create|delete|put|terminate)\b/i, why: "changes cloud resources" },
  { re: /\b(kubectl|helm)\s+(apply|delete|upgrade|rollout)\b/i, why: "changes cluster state" },
];

/** The shell command inside a tool input, if this call runs one. */
function shellCommand(input: Record<string, unknown>): string | null {
  const cmd = input.command ?? input.cmd ?? input.script;
  return typeof cmd === "string" ? cmd : null;
}

/**
 * Classify a tool call. Returns null when the call is ordinary and may run unattended.
 * `toolName` matches the tool spec name (e.g. "bash", "write_file", "browser").
 */
export function riskOf(toolName: string, input: Record<string, unknown>): Risk | null {
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
    // A plain click/type can be anything, so only the clearly committing forms are gated: submitting a
    // form or pressing Enter/Return. The coordinator's note asks exactly this until control-label
    // classification (which button this really is) is available.
    if (action === "type" && input.submit === true) return { level: "outward", why: "submits a form" };
    if (action === "press" && /^(enter|return)$/i.test(String(input.key ?? ""))) {
      return { level: "outward", why: "presses Enter (may submit)" };
    }
    if (/submit|purchase|buy|checkout|send|post/i.test(action)) {
      return { level: "outward", why: `performs a web action (${action})` };
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