/**
 * VM-only enforcement.
 *
 * The agent may only ever act inside the user's VM. This module decides —
 * purely, from the tool name and its input — whether a tool call targets the
 * host (host filesystem, container runtime socket, or a host-local network
 * service such as the Docker bridge gateway). Anything it flags is a hard
 * deny regardless of approval mode, including auto-approve.
 *
 * The policy is deliberately narrow and server-side: it matches the concrete
 * escape hatches a VM-mounted tool could use, not every path that happens to
 * be unusual. Legitimate VM paths (/workspace, /tmp, /home/agent) pass.
 */

export interface VmOnlyDenial {
  level: "deny";
  reason: string;
}

/** Filesystem markers that only refer to the host, never the agent's VM. */
const HOST_PATH_MARKERS = [
  "/host/",
  "/mnt/host",
  "/proc/1/root",
  "/var/run/docker.sock",
  "/run/docker.sock",
  "/run/host/",
  "/var/run/host/",
  "\\\\.\\pipe\\docker",
];

/** Host-local DNS names / addresses that resolve to the machine running the VM. */
const HOST_NETWORK_TARGETS = [
  "host.docker.internal",
  "gateway.docker.internal",
  "host.containers.internal",
  "host-gateway",
  "docker.for.mac.host.internal",
  "docker.for.win.localhost",
  "172.17.0.1",
  "172.18.0.1",
];

/** Commands that enter a namespace outside the assigned VM. */
const HOST_NAMESPACE_COMMANDS = ["nsenter"];

/** Input keys whose values are filesystem paths. */
const PATH_KEYS = [
  "path",
  "file_path",
  "filePath",
  "cwd",
  "dir",
  "directory",
  "file",
  "filename",
  "cwd_path",
];

/** Input keys whose values are URLs or network targets. */
const URL_KEYS = ["url", "goto", "href", "endpoint", "target", "address", "host"];

export interface VmOnlyOptions {
  /** Extra host-local hostnames to refuse (e.g. deployment-specific aliases). */
  extraHosts?: readonly string[];
}

function normalizeHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  // Drop credentials, port and IPv6 brackets.
  const at = host.lastIndexOf("@");
  if (at >= 0) host = host.slice(at + 1);
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end > 0) host = host.slice(1, end);
  } else {
    const colon = host.indexOf(":");
    if (colon >= 0) host = host.slice(0, colon);
  }
  return host.replace(/\.$/, "");
}

function isHostNetworkTarget(raw: string, options?: VmOnlyOptions): boolean {
  const host = normalizeHost(raw);
  if (!host) return false;
  if (HOST_NETWORK_TARGETS.includes(host)) return true;
  return (options?.extraHosts ?? []).some((h) => normalizeHost(h) === host);
}

function describePathHit(path: string): string | undefined {
  const lower = path.toLowerCase();
  return HOST_PATH_MARKERS.find((marker) => lower.includes(marker));
}

function hostsFromUrls(text: string, options?: VmOnlyOptions): string | undefined {
  // Bare URLs inside shell commands or strings.
  const re = /\b(?:https?|wss?|ftp):\/\/([^/\s'"`<>]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (isHostNetworkTarget(match[1], options)) return match[1];
  }
  return undefined;
}

/** Host part of a URL-valued input field (or the bare host itself). */
function hostFromUrlValue(value: string, options?: VmOnlyOptions): string | undefined {
  const trimmed = value.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    const host = url.hostname;
    return host && isHostNetworkTarget(host, options) ? host : undefined;
  } catch {
    return isHostNetworkTarget(trimmed, options) ? trimmed : undefined;
  }
}

function denial(reason: string): VmOnlyDenial {
  return {
    level: "deny",
    reason: `VM-only policy: ${reason}. Tool calls may only act inside the user's VM.`,
  };
}

function scanText(
  text: string,
  source: string,
  options?: VmOnlyOptions,
): VmOnlyDenial | undefined {
  const marker = describePathHit(text);
  if (marker) return denial(`${source} references the host path "${marker}"`);
  const host = hostsFromUrls(text, options);
  if (host) return denial(`${source} targets host-local address "${host}"`);
  return undefined;
}

function scanToolInput(
  name: string,
  input: unknown,
  options?: VmOnlyOptions,
): VmOnlyDenial | undefined {
  if (typeof input === "string") return scanText(input, name, options);
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;

  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string") {
      const hit = scanText(value, `${name}.${key}`, options);
      if (hit) return hit;
    }
  }
  for (const key of URL_KEYS) {
    const value = record[key];
    if (typeof value === "string") {
      const host = hostFromUrlValue(value, options);
      if (host) return denial(`${name}.${key} targets host-local address "${host}"`);
    }
  }

  // Shell-style tools: scan the whole command line(s), including heredocs.
  for (const key of ["command", "cmd", "script", "input"]) {
    const value = record[key];
    if (typeof value === "string") {
      const hit = scanText(value, `${name}.${key}`, options);
      if (hit) return hit;
      const marker = HOST_NAMESPACE_COMMANDS.find((command) =>
        new RegExp(`(^|[\\s;&|(])${command}(\\s|$)`).test(value.toLowerCase()),
      );
      if (marker) return denial(`${name} uses "${marker}" to enter host namespaces`);
    }
  }

  return undefined;
}

/**
 * Classify a tool call against the VM-only policy.
 * Returns a deny decision when the call targets the host, otherwise null.
 */
export function classifyHostTarget(
  toolName: string,
  input: unknown,
  options?: VmOnlyOptions,
): VmOnlyDenial | null {
  const name = toolName || "tool";
  return scanToolInput(name, input, options) ?? null;
}
