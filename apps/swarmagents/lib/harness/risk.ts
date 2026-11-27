/**
 * Pure risk classifier for agent tool calls.
 *
 * Decides, from the tool name and its input alone, whether a call may proceed
 *   ("allow"), needs explicit human approval ("ask"), or must never be allowed
 *   ("deny"). The classifier is deliberately side-effect free: it does not read
 * env, disk, or time, so it is trivially unit-testable and safe to run before
 * anything touches an approval store.
 *
 * Policy summary:
 *   - deny: reading/exfiltrating secret environment variables, and touching
 *     system credential files (/etc/passwd, /etc/shadow, /etc/sudoers, ...).
 *     WebFetch is denied outright (no approval can lift it) when its target
 *     is a private / loopback / link-local literal or reserved hostname, or
 *     — via the async classifier's DNS preflight — a hostname that resolves
 *     into that space.
 *   - ask: destructive root deletions (rm -rf /), remote-piped shell execution
 *     (curl|sh), docker/podman, credential files (git push --force, writing to
 *     ~/.ssh or .env), privileged commands (sudo), disk/partition tools,
 *     system package manager mutations, and egress to unknown network hosts.
 *   - allow: everything else (read-only inspection, local builds, tests, ...).
 */

import path from "node:path";
import { classifyDesktopToolCall, classifyDesktopToolCallAsync, isDesktopMcpCall } from "./computer-mcp";
import { checkNavigation, checkNavigationAsync, lookupAddresses } from "../browser/policy";
import { classifyHostTarget } from "./vm-only";
import { classifyCommand as classifyShellAst } from "../safety/shell-classifier";
import { DEFAULT_ALLOWLISTED_HOSTS } from "../safety/shell-classifier/rules";

export type RiskLevel = "allow" | "ask" | "deny";

export interface RiskDecision {
  level: RiskLevel;
  /** Short human-readable reason the level was chosen (for the approval UI). */
  reason: string;
  /**
   * The deny is only about malformed arguments that the tool itself rejects
   * (computer-mcp validates with the same parser), so nothing would run.
   * The post-hoc gate must not halt the run on it: the model sees the tool's
   * error and corrects the call, as it does through the approval hook.
   */
  malformed?: true;
}

/** Hosts the agent is trusted to talk to without asking. */
const SAFE_FETCH_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
  "www.npmjs.org",
  "npmjs.com",
  "www.npmjs.com",
  "docs.anthropic.com",
  "platform.openai.com",
  "nodejs.org",
  "developer.mozilla.org",
  "www.typescriptlang.org",
  "www.python.org",
  "pypi.org",
  "files.pythonhosted.org",
]);

const SECRET_ENV_VAR = /(key|token|secret|password|passwd|auth|bearer|credential)/i;

/** System credential stores — never readable or writable by an agent. */
const SYSTEM_CREDENTIAL_PATHS =
  /\/etc\/(passwd|shadow|gshadow|sudoers|ssh|[^/\s]*ssh)|\/proc\/(?:\d+|self|thread-self)\/(?:environ|cmdline|mem|fd\/)/i;

/** User-level credential files — any read or write needs approval. */
const CREDENTIAL_PATH = /(\.ssh|\.aws|\.gnupg|\.docker|\.kube|kubeconfig|id_rsa|id_ed25519|id_ecdsa|id_dsa|\.pem|\.key\b|\.env\b|credentials|\.npmrc|\.netrc|\.pgpass|\.my\.cnf|\.git-credentials|\.bash_history|\.zsh_history)/i;

/** A variable reference that appears inside a disclosure context (printing it). */
function disclosedSecretVar(command: string): string | undefined {
  const re = /(cat|echo|printf|printenv|env|grep|sed|awk|head|tail|less|more|strings|cut|base64|xxd|od|python|python3|node|ruby|perl|php)\b[^\n|&;]*\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    if (SECRET_ENV_VAR.test(m[2])) return m[2];
  }
  return undefined;
}

function hasSecretEnvRef(command: string): boolean {
  const re = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    if (SECRET_ENV_VAR.test(m[1])) return true;
  }
  return false;
}

/** Does an argument position reference a system credential file? */
function touchesSystemCredentials(command: string): boolean {
  return SYSTEM_CREDENTIAL_PATHS.test(command.replace(/['"]/g, ""));
}

/** Does the command write to (or overwrite) a credential path? */
function writesCredential(command: string): boolean {
  const bare = command.replace(/['"]/g, "");
  if (!CREDENTIAL_PATH.test(bare)) return false;
  // Writes: redirection, tee, atomic cp/mv, dd, truncate.
  return /(^|[|&;]\s*)(>|>>|tee|cp|mv|truncate|install|dd)\b|\s(>|>>)\s|>\s?\S/.test(command);
}

/** Does the command read a credential path (cat, edit, grep, ...)? */
function readsCredential(command: string): boolean {
  const bare = command.replace(/['"]/g, "");
  if (!CREDENTIAL_PATH.test(bare)) return false;
  return /(^|[|&;]\s*)(cat|type|open|vi|vim|nano|emacs|less|more|head|tail|grep|sed|awk|strings|find)\b/.test(command);
}

function isRootDestructiveTarget(arg: string): boolean {
  const a = arg.trim();
  // Absolute paths, home, and wildcards can reach outside the working tree.
  if (a.startsWith("/") || a.startsWith("~/") || a === "~" || a === "*" || a === "." || a === "..") return true;
  return /^\/(usr|etc|var|opt|bin|sbin|lib|root|boot|home)(\s|$)/.test(a);
}

function systemPackageMutation(command: string): boolean {
  const op = /\b(install|remove|purge|autoremove|upgrade|dist-upgrade|uninstall|publish|global)\b/;
  if (/(apt-get|apt\b|dnf|yum|zypper|pacman|apk)\b/.test(command) && op.test(command)) return true;
  if (/\bnpm\b/.test(command) && /(--global|-g\b|uninstall|publish)/.test(command)) return true;
  if (/\byarn\b/.test(command) && /\b(global|remove|uninstall|publish)\b/.test(command)) return true;
  if (/(pip|pip3|poetry|uv)\b/.test(command) && /\b(install|uninstall|remove)\b/.test(command)) return true;
  if (/\bbrew\b/.test(command) && /\b(install|remove|uninstall|upgrade|services)\b/.test(command)) return true;
  return false;
}

function parseUrlHostname(rawUrl: string): string | undefined {
  const cleaned = rawUrl.trim().replace(/^['"`(]+|['"`),;]+$/g, "");
  try {
    const parsed = new URL(cleaned);
    return parsed.hostname ? parsed.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function networkHostOf(command: string): string | undefined {
  const m = /https?:\/\/[^\s'"]+/.exec(command);
  return m ? parseUrlHostname(m[0]) : undefined;
}

/** Every https?:// host in a command — a downloader check must see all of them, not just the first. */
function networkHostsOf(command: string): string[] {
  const hosts: string[] = [];
  const re = /https?:\/\/[^\s'"]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    // Empty string ensures a malformed URL is treated as an unknown host rather than skipped.
    hosts.push(parseUrlHostname(m[0]) ?? "");
  }
  return hosts;
}

function downloaderToUnknownHost(command: string): boolean {
  const dl = /\b(curl|wget|fetch|aria2c|httpie|http)\b/i;
  if (!dl.test(command)) return false;
  const hosts = networkHostsOf(command);
  if (hosts.length === 0) return false;
  return hosts.some((host) => !SAFE_FETCH_HOSTS.has(host));
}

/** Classify a path string by whether it names credential material. */
function classifyPath(filePath: string): RiskDecision | null {
  if (!filePath) return null;
  const normalized = path.posix.normalize(filePath.replace(/\/+/g, "/"));
  if (SYSTEM_CREDENTIAL_PATHS.test(normalized) || SYSTEM_CREDENTIAL_PATHS.test(filePath)) {
    return { level: "deny", reason: "system credential files are off-limits" };
  }
  if (CREDENTIAL_PATH.test(normalized) || CREDENTIAL_PATH.test(filePath)) {
    return { level: "ask", reason: "credential file access requires approval" };
  }
  return null;
}

function pathOf(input: Record<string, unknown>): string {
  return typeof input.file_path === "string" ? input.file_path
    : typeof input.path === "string" ? input.path
    : typeof input.notebook_path === "string" ? input.notebook_path
    : "";
}

function riskyToolCall(
  name: string,
  input: unknown,
  opts: { textDesktop?: boolean } = {},
): RiskDecision | null {
  if (name === "Bash" || name === "Terminal" || name === "Shell" || name === "cmd") {
    const command = input && typeof input === "object" && "command" in input && typeof (input as { command: unknown }).command === "string"
      ? (input as { command: string }).command
      : "";
    return classifyCommand(command);
  }

  // Tools that take a file path (Read, Grep, Write, Edit, Ls, Search, ...):
  // credential paths get the same treatment as the equivalent shell command.
  if (input && typeof input === "object") {
    const path = pathOf(input as Record<string, unknown>);
    const byPath = classifyPath(path);
    if (byPath) return byPath;
  }

  if (name === "WebFetch") {
    const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const url = typeof obj.url === "string" ? obj.url : "";
    // Hard SSRF block, no DNS needed: a private / loopback / link-local
    // address literal or a reserved hostname (localhost, *.local,
    // metadata.google.internal, ...) is denied even if a human approved the
    // fetch. Hostnames that merely *look* public get the DNS preflight in
    // classifyToolCallAsync below.
    if (url) {
      const nav = checkNavigation(url);
      if (!nav.ok) {
        return { level: "deny", reason: `WebFetch to a private destination is not allowed (${nav.reason})` };
      }
    }
    const host = networkHostOf(url);
    if (host && !SAFE_FETCH_HOSTS.has(host)) {
      return { level: "ask", reason: `fetching from ${host} requires approval` };
    }
    return null;
  }

  // Computer-use (desktop / headless browser MCP) tools have their own policy: the
  // computer-use validator's argument gates and the browser navigation rules.
  // In text-desktop mode the same classifier denies raw screenshot calls.
  const desktop = classifyDesktopToolCall(name, input, opts);
  if (desktop) return desktop;

  // Read-only inspection tools, search, tasks, MCP tools, and anything else we
  // don't have a policy for are allowed to proceed.
  return null;
}

/**
 * Classify a tool call by tool name + input. Pure: same inputs always yield the
 * same decision. `opts.textDesktop` denies raw screenshot calls (a model
 * without vision cannot use image bytes); only pass it from a pre-execution
 * gate — see classifyDesktopToolCall.
 */
export function classifyToolCall(
  name: string,
  input: unknown,
  opts: { textDesktop?: boolean } = {},
): RiskDecision {
  // VM-only boundary first: nothing below may downgrade a host-targeted call,
  // and nothing above it (auto-approve included) can upgrade it to allow.
  const hostTarget = classifyHostTarget(name, input);
  if (hostTarget) return hostTarget;
  const toolSpecific = riskyToolCall(name, input, opts);
  if (toolSpecific) return toolSpecific;
  return { level: "allow", reason: "benign tool call" };
}

/**
 * DNS-aware WebFetch gate: the synchronous classifier above catches private
 * address literals and reserved hostnames, but a public-looking hostname can
 * still resolve into private / loopback / link-local / CGNAT space (DNS
 * rebinding, a hostile or compromised record). This runs the same DNS
 * preflight the browser manager uses (`checkNavigationAsync`) and denies
 * the fetch when any A/AAAA record lands in that space — even if a human
 * approved it. Returns null when the fetch is not DNS-blocked, so the
 * caller falls through to the synchronous classifier (allowlisted host ->
 * allow, anything else -> ask). `lookup` is injectable for tests.
 */
async function classifyWebFetchAsync(
  input: unknown,
  lookup: (host: string) => Promise<string[]> = lookupAddresses,
): Promise<RiskDecision | null> {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const url = typeof obj.url === "string" ? obj.url : "";
  if (!url) return null;
  const check = await checkNavigationAsync(url, lookup);
  if (!check.ok) {
    return { level: "deny", reason: `WebFetch to a private destination is not allowed (${check.reason})` };
  }
  return null;
}

/**
 * Async classification used by the runner: WebFetch gets the DNS-aware
 * decision (which denies a public-looking hostname that resolves into
 * private / loopback / metadata space); computer-use tool calls get the
 * same treatment for browser navigation, where explicit loopback URLs are
 * the only local-preview exception. Every other tool falls through to the
 * pure synchronous classifier.
 */
export async function classifyToolCallAsync(
  name: string,
  input: unknown,
  lookup?: (host: string) => Promise<string[]>,
  opts: { textDesktop?: boolean } = {},
): Promise<RiskDecision> {
  const hostTarget = classifyHostTarget(name, input);
  if (hostTarget) return hostTarget;
  if (name === "WebFetch") {
    const webFetch = await classifyWebFetchAsync(input, lookup);
    if (webFetch) return webFetch;
  }
  if (!isDesktopMcpCall(name)) return classifyToolCall(name, input, opts);
  const desktop = await classifyDesktopToolCallAsync(name, input, lookup, opts);
  return desktop ?? { level: "allow", reason: "benign tool call" };
}

/**
 * Classify a shell command string (the input of the Bash tool).
 *
 * The command is inspected as text; nothing is executed, read, or resolved
 * here. A single command may match several rules; deny wins over ask, ask wins
 * over allow.
 */
export function classifyCommand(raw: string): RiskDecision {
  return stricter(classifyCommandPatterns(raw), classifyCommandAst(raw));
}

const LEVEL_RANK: Record<RiskLevel, number> = { allow: 0, ask: 1, deny: 2 };

/** Pick the stricter of two decisions (the first one wins ties). */
function stricter(a: RiskDecision, b: RiskDecision): RiskDecision {
  return LEVEL_RANK[b.level] > LEVEL_RANK[a.level] ? b : a;
}

/** The agent's VM: commands run as `node` with /workspace as the work tree. */
const VM_WORKSPACE = "/workspace";
const VM_HOME = "/home/node";
const AST_ALLOWLISTED_HOSTS = [...DEFAULT_ALLOWLISTED_HOSTS, ...SAFE_FETCH_HOSTS];

/**
 * "review" categories that are routine inside the agent's own throwaway VM
 * (writing to /tmp, `kill <pid>`, `source venv/bin/activate`, pushing a
 * branch) and so do not need a human in the loop.
 */
const AST_REVIEW_IGNORED = new Set(["workspace_escape", "process_control", "execution", "package_publish"]);
/** `pkill`/`killall` only reach processes inside the user's own VM. */
const AST_BLOCK_IGNORED = new Set(["process_control"]);

/**
 * AST-based second opinion (lib/safety/shell-classifier). It tokenizes and
 * parses the command, recurses into sh -c / eval / $(...) / backticks /
 * process substitution / xargs / find -exec / base64-decoded payloads, and
 * catches obfuscations the patterns above miss (r''m, a=rm; $a, ... | base64
 * -d | sh, printenv | nc, /dev/tcp reverse shells, fork bombs).
 *
 * Mapping: secret exfiltration (secrets + network_exfil) and fork bombs are
 * denied; any other "block" asks; "review" asks unless it is VM-routine.
 * If the parser throws, the command is sent for approval rather than allowed.
 */
export function classifyCommandAst(raw: string): RiskDecision {
  if (!raw.trim()) return { level: "allow", reason: "benign command" };
  let result: ReturnType<typeof classifyShellAst>;
  try {
    result = classifyShellAst({
      command: raw,
      cwd: VM_WORKSPACE,
      workspaceRoot: VM_WORKSPACE,
      homeDir: VM_HOME,
      allowlistedHosts: AST_ALLOWLISTED_HOSTS,
      role: { allowBash: true, allowWrite: true, allowNetwork: true, readOnly: false },
    });
  } catch {
    return { level: "ask", reason: "command could not be parsed safely; approval required" };
  }
  const categories = new Set(result.categories);
  const reason = result.reasons[0] ?? "flagged by shell classifier";
  if (result.risk === "block") {
    if (categories.has("fork_bomb") || (categories.has("secrets") && categories.has("network_exfil"))) {
      return { level: "deny", reason };
    }
    if (categories.size > 0 && [...categories].every((c) => AST_BLOCK_IGNORED.has(c))) {
      return { level: "allow", reason: "benign command" };
    }
    return { level: "ask", reason: `${reason} — requires approval` };
  }
  if (result.risk === "review" && [...categories].some((c) => !AST_REVIEW_IGNORED.has(c))) {
    return { level: "ask", reason: `${reason} — requires approval` };
  }
  return { level: "allow", reason: "benign command" };
}

/** The original regex rules (kept as the first line of defence). */
function classifyCommandPatterns(raw: string): RiskDecision {
  const command = raw.trim();

  // --- deny: never allowed, no approval can lift it ---

  const disclosed = disclosedSecretVar(command);
  if (disclosed) {
    return { level: "deny", reason: `printing ${disclosed} would exfiltrate a secret` };
  }
  if (touchesSystemCredentials(command)) {
    return { level: "deny", reason: "system credential files are off-limits" };
  }
  if (hasSecretEnvRef(command) && /(echo|printf|printenv|env|cat|grep|sed|awk|head|tail)\b/.test(command)) {
    return { level: "deny", reason: "referencing a secret environment variable is not allowed" };
  }
  if (/(^|[|&;]\s*)(printenv|env)\s*($|[|&;])|(^|[|&;]\s*)(export|declare)\s+-[a-zA-Z]*p\b/i.test(command)) {
    return { level: "deny", reason: "dumping environment variables would exfiltrate secrets" };
  }
  // Cloud instance metadata endpoints are a classic credential-exfiltration vector.
  if (/(169\.254\.169\.254|metadata\.(google|azure|amazonaws)\.internal|100\.100\.100\.200)/.test(command)) {
    return { level: "deny", reason: "cloud instance metadata is off-limits" };
  }

  // --- ask: risky but legitimate with human approval ---

  // rm -rf / (and other destructive root deletions).
  const rmRe = /\brm\b/g;
  let rmMatch: RegExpExecArray | null;
  while ((rmMatch = rmRe.exec(command)) !== null) {
    const tail = command.slice(rmMatch.index + 2).split(/\s*(?:&&|\|\||[;|\n])\s*/)[0] ?? "";
    if (!/-\S*[rf]\S*/.test(tail)) continue;
    const targets = tail
      .trim()
      .split(/\s+/)
      .map((a) => a.replace(/^['"]|['"]$/g, ""))
      .filter((a) => a.length > 0 && !a.startsWith("-"));
    if (targets.some(isRootDestructiveTarget)) {
      return { level: "ask", reason: "destructive root deletion requires approval" };
    }
  }

  // curl ... | sh — executing remotely downloaded code.
  if (/\b(curl|wget|fetch|aria2c|httpie|http)\b/i.test(command) && /\|\s*(sh|bash|zsh|dash|fish|ksh)\b/.test(command)) {
    return { level: "ask", reason: "piping a remote download into a shell requires approval" };
  }

  // Any download from a host we don't trust (network egress).
  if (downloaderToUnknownHost(command)) {
    return { level: "ask", reason: "downloading from an unknown host requires approval" };
  }

  // Containers.
  if (/\b(docker|podman|nerdctl|limactl|colima)\b/.test(command)) {
    return { level: "ask", reason: "container commands require approval" };
  }

  // Git destructive/force operations.
  if (/\bgit\b/.test(command) && /\b(push|reset|clean|checkout|rebase)\b/.test(command) && /(--force|-f\b|--hard)/.test(command)) {
    return { level: "ask", reason: "force/destructive git operations require approval" };
  }

  // Credential files (read or write).
  if (writesCredential(command) || readsCredential(command)) {
    return { level: "ask", reason: "credential file access requires approval" };
  }

  // Privilege elevation.
  if (/(^|\s)(sudo|doas)\s+/.test(command) || /\bsu\s+(-|root)/.test(command)) {
    return { level: "ask", reason: "privilege elevation requires approval" };
  }

  // Disk/partition tools.
  if (/\b(mkfs|fdisk|parted|wipefs|shred|blkdiscard|mkswap|swapon|swapoff)\b/.test(command)) {
    return { level: "ask", reason: "disk/partition operations require approval" };
  }
  if (/\bdd\b/.test(command) && /\bof=\/dev\//.test(command)) {
    return { level: "ask", reason: "writing to a block device requires approval" };
  }

  // Broad permission changes.
  if (/\b(chmod|chown)\b/.test(command) && /(-R|777|666|a\+|a=)/.test(command)) {
    return { level: "ask", reason: "broad permission changes require approval" };
  }

  // System package manager mutations.
  if (systemPackageMutation(command)) {
    return { level: "ask", reason: "system package changes require approval" };
  }

  // Service/network control.
  if (/\b(systemctl|service|rc-service)\b/.test(command) && /\b(start|stop|restart|enable|disable|mask|unmask|daemon-reload|reload)\b/.test(command)) {
    return { level: "ask", reason: "service control requires approval" };
  }
  if (/\b(iptables|ufw|nft)\b/.test(command)) {
    return { level: "ask", reason: "firewall changes require approval" };
  }

  // Remote shell/file copy (network egress to another machine).
  if (/\b(ssh|scp|rsync)\b/.test(command) && /@/.test(command)) {
    return { level: "ask", reason: "connecting to a remote host requires approval" };
  }

  return { level: "allow", reason: "benign command" };
}
