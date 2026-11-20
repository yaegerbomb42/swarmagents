import {
  classifyPathSensitivity,
  isStandardDevice,
  isSystemCriticalPath,
  isWithinWorkspace,
  isWorkspaceRootItself,
  resolveCommandPath,
} from "./paths";
import type {
  AnalysisContext,
  CommandNode,
  Finding,
  PipelineNode,
  RedirectNode,
  SimpleCommandNode,
  WordToken,
} from "./types";

export const DEFAULT_ALLOWLISTED_HOSTS = [
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
  "host.docker.internal",
  "*.localhost",
];

export const SHELL_BINARIES = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ash",
  "ksh",
  "mksh",
  "fish",
  "csh",
  "tcsh",
]);

export const TRANSPARENT_WRAPPERS = new Set([
  "command",
  "builtin",
  "nohup",
  "nice",
  "ionice",
  "stdbuf",
  "time",
  "strace",
  "ltrace",
  "setsid",
]);

const PRIVILEGE_COMMANDS = new Set([
  "sudo",
  "su",
  "doas",
  "pkexec",
  "gksudo",
  "kdesudo",
  "runuser",
  "chroot",
  "nsenter",
  "unshare",
  "capsh",
  "setcap",
]);

const NETWORK_COMMANDS = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "telnet",
  "ftp",
  "sftp",
  "scp",
  "rsync",
  "ssh",
  "ping",
  "ping6",
  "traceroute",
  "tracepath",
  "mtr",
  "dig",
  "nslookup",
  "host",
  "whois",
  "aria2c",
  "http",
  "https",
]);

const WRITE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "truncate",
  "dd",
  "mkfs",
  "mkfs.ext4",
  "mkfs.ext3",
  "mkfs.xfs",
  "mkfs.vfat",
  "mkfs.btrfs",
  "fdisk",
  "parted",
  "gdisk",
  "wipefs",
  "shred",
  "chmod",
  "chown",
  "chgrp",
  "ln",
  "install",
  "patch",
  "tee",
  "unzip",
  "unrar",
  "7z",
]);

const FILE_READ_COMMANDS = new Set([
  "cat",
  "less",
  "more",
  "head",
  "tail",
  "bat",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "awk",
  "gawk",
  "sed",
  "cut",
  "sort",
  "uniq",
  "wc",
  "strings",
  "xxd",
  "hexdump",
  "od",
  "base64",
  "base32",
  "cp",
  "mv",
  "scp",
  "rsync",
  "tar",
  "zip",
  "gzip",
  "openssl",
  "jq",
  "yq",
  "source",
  ".",
]);

const ENV_DUMP_COMMANDS = new Set(["printenv", "env", "export", "set"]);

const PERSISTENCE_COMMANDS = new Set([
  "crontab",
  "systemctl",
  "service",
  "update-rc.d",
  "chkconfig",
  "at",
  "batch",
]);

const PUBLISH_COMMANDS = new Set([
  "twine",
  "flit",
  "poetry",
  "hatch",
  "uv",
  "gem",
  "gh",
  "helm",
]);

const URL_EXTRACT_RE =
  /\b(?:https?|ftp|sftp|ftps|ws|wss|ssh|git|rsync):\/\/(\[[0-9a-fA-F:.]+\](?::\d+)?|[^\s/'":@[]+(?::\d+)?)/gi;
const DEV_NET_RE = /^\/dev\/(?:tcp|udp)\/([^/]+)\/(\d+)$/;
const SCP_TARGET_RE = /^(?:[a-zA-Z0-9._-]+@)?([a-zA-Z0-9.-]+):(.*)$/;
const BASE64_LITERAL_RE = /^[A-Za-z0-9+/]{8,}={0,2}$/;

export function addFinding(ctx: AnalysisContext, finding: Finding): void {
  ctx.findings.push(finding);
}

export function basenameCmd(cmd: string): string {
  const slashIdx = cmd.lastIndexOf("/");
  return slashIdx >= 0 ? cmd.slice(slashIdx + 1) : cmd;
}

export function isHostAllowlisted(
  rawHost: string,
  ctx: AnalysisContext,
): boolean {
  const lower = rawHost.toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(lower);
  // Only strip a :port suffix from non-IPv6 hosts (`::1` must stay `::1`).
  const host = bracketed
    ? bracketed[1]!
    : (lower.match(/:/g) ?? []).length > 1
      ? lower
      : lower.replace(/:\d+$/, "");
  if (!host) return false;
  if (ctx.allowlistedHosts.has(host) || ctx.allowlistedHosts.has(`[${host}]`)) {
    return true;
  }
  for (const suffix of ctx.allowlistedWildcards) {
    if (host.endsWith(suffix) && host.length > suffix.length) {
      return true;
    }
  }
  return false;
}

export function extractHostnameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch {
    const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:\[([^\]]+)\]|([^/:?#]+))/.exec(
      url,
    );
    const host = m?.[1] ?? m?.[2];
    return host ? host.toLowerCase() : null;
  }
}

export function recordNetworkTarget(
  target: string,
  ctx: AnalysisContext,
): string | null {
  const trimmed = target.trim();
  if (!trimmed) return null;

  const devNet = DEV_NET_RE.exec(trimmed);
  if (devNet && devNet[1]) {
    const host = devNet[1].toLowerCase();
    ctx.networkTargets.add(host);
    return host;
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    const host = extractHostnameFromUrl(trimmed);
    if (host) {
      ctx.networkTargets.add(host);
      return host;
    }
  }

  const scpMatch = SCP_TARGET_RE.exec(trimmed);
  if (scpMatch && scpMatch[1] && !trimmed.startsWith("/")) {
    // Avoid mistaking Windows paths like C:\foo (not relevant on Linux, single char)
    if (scpMatch[1].length > 1) {
      const host = scpMatch[1].toLowerCase();
      ctx.networkTargets.add(host);
      return host;
    }
  }

  // Plain hostname or IP
  const cleanHost = trimmed
    .replace(/^[a-zA-Z0-9._-]+@/, "")
    .replace(/:\d+$/, "")
    .toLowerCase();
  if (
    cleanHost &&
    !cleanHost.startsWith("-") &&
    !cleanHost.startsWith("/") &&
    !cleanHost.startsWith(".")
  ) {
    ctx.networkTargets.add(cleanHost);
    return cleanHost;
  }

  return null;
}

export function recordPathTouch(
  rawPath: string,
  ctx: AnalysisContext,
): string | null {
  if (!rawPath || rawPath === "-") return null;

  // Check /dev/tcp/<host>/<port> or /dev/udp/<host>/<port>
  const devNet = DEV_NET_RE.exec(rawPath);
  if (devNet) {
    recordNetworkTarget(rawPath, ctx);
    return rawPath;
  }

  const resolved = resolveCommandPath(rawPath, ctx.cwd, ctx.homeDir);
  if (isStandardDevice(resolved)) {
    return resolved;
  }
  ctx.touchesPaths.add(resolved);
  return resolved;
}

/**
 * Checks for structural fork bombs such as `:(){ :|:& };:` or `bomb() { bomb | bomb & }; bomb`.
 */
export function evaluateForkBombNode(
  node: CommandNode,
  ctx: AnalysisContext,
): void {
  if (node.kind !== "function") return;

  const fnName = node.name;
  let selfCalls = 0;
  let hasBackground = false;
  let hasPipe = false;

  const inspectPipeline = (p: PipelineNode) => {
    if (p.terminator === "&") hasBackground = true;
    if (p.segments.length > 1) hasPipe = true;
    for (const seg of p.segments) {
      inspectCmd(seg.command);
    }
  };

  const inspectCmd = (c: CommandNode) => {
    if (c.kind === "simple") {
      const head = c.argv[0]?.value;
      if (head === fnName) selfCalls++;
    } else if (c.kind === "subshell" || c.kind === "group") {
      for (const p of c.pipelines) inspectPipeline(p);
    } else if (c.kind === "function") {
      inspectCmd(c.body);
    }
  };

  inspectCmd(node.body);

  if (selfCalls >= 2 || (selfCalls >= 1 && hasBackground && hasPipe)) {
    addFinding(ctx, {
      risk: "block",
      category: "fork_bomb",
      reason: `Fork bomb detected in recursive function '${fnName}'`,
    });
  }
}

/**
 * Evaluates redirects on any command/subshell (handles writes, secret reads/writes, /dev/tcp).
 */
export function evaluateRedirects(
  redirects: RedirectNode[],
  ctx: AnalysisContext,
): void {
  for (const r of redirects) {
    // Dup fd redirects like 2>&1, >&2, <&0 do not touch filesystem paths
    if (
      (r.op === ">&" || r.op === "<&") &&
      /^(?:\d+|-)$/.test(r.target.value)
    ) {
      continue;
    }

    // Here-string <<< or heredoc << target is delimiter/string, not file path
    if (r.op === "<<" || r.op === "<<-" || r.op === "<<<") {
      continue;
    }

    const rawTarget = r.target.value;
    const resolved = recordPathTouch(rawTarget, ctx);
    if (!resolved) continue;

    // Network virtual devices /dev/tcp/host/port
    if (DEV_NET_RE.test(rawTarget)) {
      if (!ctx.role.allowNetwork) {
        addFinding(ctx, {
          risk: "block",
          category: "role",
          reason: `Network redirection (${rawTarget}) blocked because allowNetwork is false`,
        });
      }
      const host = recordNetworkTarget(rawTarget, ctx);
      if (host && !isHostAllowlisted(host, ctx)) {
        addFinding(ctx, {
          risk: "block",
          category: "network_exfil",
          reason: `Network redirection to non-allowlisted host (${rawTarget})`,
        });
      }
      continue;
    }

    if (isStandardDevice(resolved)) continue;

    const isWriteRedir =
      r.op === ">" ||
      r.op === ">>" ||
      r.op === ">|" ||
      r.op === "<>" ||
      r.op === "&>" ||
      r.op === "&>>" ||
      r.op === ">&";

    const sens = classifyPathSensitivity(resolved, ctx.homeDir);

    if (sens.isSecret) {
      addFinding(ctx, {
        risk: sens.secretSeverity ?? "block",
        category: "secrets",
        reason:
          sens.secretReason ??
          `Redirection involving sensitive file (${resolved})`,
      });
    }

    if (isWriteRedir) {
      if (ctx.role.readOnly || !ctx.role.allowWrite) {
        addFinding(ctx, {
          risk: "block",
          category: "role",
          reason: `File redirection to ${resolved} blocked by read-only/no-write role`,
        });
      }

      if (sens.isPersistence) {
        addFinding(ctx, {
          risk: "block",
          category: "persistence",
          reason:
            sens.persistenceReason ??
            `Write redirection to persistence file (${resolved})`,
        });
      } else if (!isWithinWorkspace(resolved, ctx.workspaceRoot)) {
        addFinding(ctx, {
          risk: isSystemCriticalPath(resolved) ? "block" : "review",
          category: "workspace_escape",
          reason: `File write redirection outside workspace (${resolved})`,
        });
      }
    } else if (r.op === "<") {
      if (!isWithinWorkspace(resolved, ctx.workspaceRoot) && !sens.isSecret) {
        // Reading arbitrary non-secret file outside workspace (e.g. /etc/os-release) -> review
        addFinding(ctx, {
          risk: "review",
          category: "workspace_escape",
          reason: `Reading file outside workspace (${resolved})`,
        });
      }
    }
  }
}

/**
 * Evaluates a single SimpleCommandNode for all non-recursive rules.
 */
export function evaluateSimpleCommand(
  cmd: SimpleCommandNode,
  effectiveArgv: WordToken[],
  pipelineContext: {
    pipedToShell: boolean;
    pipedToNetwork: boolean;
    pipedFromNetwork: boolean;
  },
  ctx: AnalysisContext,
): void {
  if (effectiveArgv.length === 0) return;

  const headToken = effectiveArgv[0]!;
  let cmdRawName = headToken.value;
  let cmdBase = basenameCmd(cmdRawName);

  // 1. Obfuscation checks on command invocation itself
  if (headToken.hasHexOrOctalEscape) {
    addFinding(ctx, {
      risk: "block",
      category: "obfuscation",
      reason: `Hex/octal escape obfuscation in command name (${headToken.raw})`,
    });
  }

  if (headToken.midWordQuoted && !headToken.singleQuoted) {
    addFinding(ctx, {
      risk: "block",
      category: "obfuscation",
      reason: `Quote/backslash obfuscation in command identifier (${headToken.raw})`,
    });
  }

  if (headToken.hasExpansion) {
    // Check if variable resolves to a known literal in local scope
    const varMatch = /^\$\{?([a-zA-Z_][a-zA-Z0-9_]*)\}?$/.exec(
      headToken.raw,
    );
    const resolvedVar = varMatch?.[1] ? ctx.vars.get(varMatch[1]) : undefined;
    addFinding(ctx, {
      risk: "block",
      category: "obfuscation",
      reason: `Dynamic command execution via variable or substitution (${headToken.raw})`,
    });
    if (resolvedVar) {
      cmdRawName = resolvedVar;
      cmdBase = basenameCmd(resolvedVar);
    }
  }

  // Check any argument for ANSI-C hex/octal escapes used to conceal payloads
  for (let i = 1; i < effectiveArgv.length; i++) {
    const arg = effectiveArgv[i]!;
    if (arg.hasHexOrOctalEscape) {
      addFinding(ctx, {
        risk: "block",
        category: "obfuscation",
        reason: `Hex/octal escape sequence detected in argument (${arg.raw})`,
      });
    }
  }

  const args = effectiveArgv.slice(1);
  const argValues = args.map((a) => a.value);

  // 2. Privilege escalation commands
  if (PRIVILEGE_COMMANDS.has(cmdBase)) {
    addFinding(ctx, {
      risk: "block",
      category: "privilege",
      reason: `Privilege escalation command '${cmdBase}' is not permitted`,
    });
  }

  // 3. Persistence commands
  if (PERSISTENCE_COMMANDS.has(cmdBase)) {
    if (cmdBase === "crontab") {
      const isListOnly =
        argValues.length === 1 &&
        (argValues[0] === "-l" || argValues[0] === "--list");
      addFinding(ctx, {
        risk: isListOnly ? "review" : "block",
        category: "persistence",
        reason: isListOnly
          ? "Inspecting user crontab"
          : "Modifying or deleting scheduled cron jobs via crontab",
      });
    } else if (cmdBase === "systemctl" || cmdBase === "service") {
      const sub = argValues.find((a) => !a.startsWith("-")) ?? "";
      const isRead = sub === "status" || sub === "list-units" || sub === "is-active";
      addFinding(ctx, {
        risk: isRead ? "review" : "block",
        category: "persistence",
        reason: isRead
          ? `Querying service status via ${cmdBase}`
          : `Modifying system service state via '${cmdBase} ${sub}'`,
      });
    } else {
      addFinding(ctx, {
        risk: "block",
        category: "persistence",
        reason: `Persistence/scheduling command '${cmdBase}' is blocked`,
      });
    }
  }

  // 4. Process control (kill, killall, pkill)
  if (cmdBase === "killall" || cmdBase === "pkill") {
    addFinding(ctx, {
      risk: "block",
      category: "process_control",
      reason: `Global process termination via '${cmdBase}' affects processes outside agent tree`,
    });
  } else if (cmdBase === "kill") {
    const pidArgs = argValues.filter(
      (a) =>
        !a.startsWith("-") ||
        a === "-1" ||
        /^-\d+$/.test(a),
    );
    // Distinguish signal flags (-9, -KILL, -TERM) from target PIDs (-1, 1, 0, <pid>)
    const targets: string[] = [];
    for (let i = 0; i < argValues.length; i++) {
      const a = argValues[i]!;
      if (a === "-s" || a === "--signal") {
        i++; // skip signal name
        continue;
      }
      if (a === "-1" || a === "0" || a === "1") {
        targets.push(a);
        continue;
      }
      if (a.startsWith("-")) {
        // Signal spec like -9, -15, -KILL
        continue;
      }
      targets.push(a);
    }
    void pidArgs;

    const killsAllOrInit = targets.some(
      (t) => t === "-1" || t === "0" || t === "1",
    );
    if (killsAllOrInit) {
      addFinding(ctx, {
        risk: "block",
        category: "process_control",
        reason: `Killing init or all processes ('kill ${targets.join(" ")}') is blocked`,
      });
    } else {
      addFinding(ctx, {
        risk: "review",
        category: "process_control",
        reason: `Sending signal to process PID (${targets.join(", ") || "unknown"}) requires ownership verification`,
      });
    }
  }

  // 5. Environment variable dumping
  if (ENV_DUMP_COMMANDS.has(cmdBase)) {
    const isEnvDump =
      cmdBase === "printenv" ||
      (cmdBase === "env" &&
        argValues.every((a) => a.startsWith("-") || a.includes("="))) ||
      (cmdBase === "export" && argValues.includes("-p")) ||
      (cmdBase === "set" && argValues.length === 0);

    if (isEnvDump) {
      if (pipelineContext.pipedToNetwork) {
        addFinding(ctx, {
          risk: "block",
          category: "secrets",
          reason: `Environment dump ('${cmdBase}') piped to network command (credential exfiltration)`,
        });
      } else if (cmd.redirects.some((r) => r.op === ">" || r.op === ">>")) {
        addFinding(ctx, {
          risk: "block",
          category: "secrets",
          reason: `Environment dump ('${cmdBase}') redirected to file`,
        });
      } else {
        addFinding(ctx, {
          risk: "review",
          category: "secrets",
          reason: `Dumping environment variables via '${cmdBase}' may expose secrets`,
        });
      }
    }
  }

  // 6. Destructive & Filesystem Commands
  evaluateFilesystemCommand(cmdBase, args, cmd.redirects, ctx);

  // 7. Secret file inspection across file-reading commands
  evaluateSecretsOnCommand(cmdBase, args, pipelineContext, ctx);

  // 8. Network & Exfiltration
  evaluateNetworkCommand(cmdBase, args, pipelineContext, ctx);

  // 9. Package publishing & Git operations
  evaluatePackageAndGit(cmdBase, args, ctx);

  // 10. Obfuscated pipe-to-shell (e.g., base64 -d | sh, printf '\x...' | bash, rev | sh)
  if (pipelineContext.pipedToShell) {
    if (
      cmdBase === "base64" ||
      cmdBase === "base32" ||
      cmdBase === "xxd" ||
      cmdBase === "rev" ||
      cmdBase === "tr" ||
      (cmdBase === "openssl" && argValues.includes("-d"))
    ) {
      addFinding(ctx, {
        risk: "block",
        category: "obfuscation",
        reason: `Encoded or obfuscated stream ('${cmdBase}') piped directly into a shell`,
      });
    } else if (cmdBase === "printf" || cmdBase === "echo") {
      const joined = argValues.join(" ");
      if (/\\x[0-9a-fA-F]{2}|\\[0-7]{3}|\\u[0-9a-fA-F]{4}/.test(joined)) {
        addFinding(ctx, {
          risk: "block",
          category: "obfuscation",
          reason: `Hex/octal escape payload in '${cmdBase}' piped into a shell`,
        });
      } else {
        addFinding(ctx, {
          risk: "review",
          category: "execution",
          reason: `Piping dynamic output from '${cmdBase}' into a shell interpreter`,
        });
      }
    }
  }
}

function evaluateFilesystemCommand(
  cmdBase: string,
  args: WordToken[],
  redirects: RedirectNode[],
  ctx: AnalysisContext,
): void {
  const argValues = args.map((a) => a.value);

  // Check if command is a known write operation
  const isSedInPlace =
    cmdBase === "sed" &&
    argValues.some((a) => a === "-i" || a === "--in-place" || a.startsWith("-i"));
  const isPerlInPlace =
    cmdBase === "perl" &&
    argValues.some((a) => a === "-i" || a.startsWith("-i"));
  const isTarExtract =
    cmdBase === "tar" &&
    argValues.some((a) => a.includes("x") || a === "--extract");
  const isFindDelete =
    cmdBase === "find" && argValues.includes("-delete");

  const isWriteOp =
    WRITE_COMMANDS.has(cmdBase) ||
    isSedInPlace ||
    isPerlInPlace ||
    isTarExtract ||
    isFindDelete;

  if (isWriteOp && (ctx.role.readOnly || !ctx.role.allowWrite)) {
    addFinding(ctx, {
      risk: "block",
      category: "role",
      reason: `Write operation '${cmdBase}' blocked because role is read-only or write-disabled`,
    });
  }

  // `rm` analysis
  if (cmdBase === "rm") {
    let recursive = false;
    let force = false;
    const operands: WordToken[] = [];
    let afterDoubleDash = false;

    for (const arg of args) {
      const v = arg.value;
      if (!afterDoubleDash && v === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (!afterDoubleDash && v.startsWith("--")) {
        if (v === "--recursive") recursive = true;
        if (v === "--force") force = true;
        continue;
      }
      if (!afterDoubleDash && v.startsWith("-") && v.length > 1) {
        if (v.includes("r") || v.includes("R")) recursive = true;
        if (v.includes("f")) force = true;
        continue;
      }
      operands.push(arg);
    }

    for (const op of operands) {
      const raw = op.value;
      // Unresolved variable inside `rm -rf` target (e.g. `rm -rf $FOO/*`) can expand to `/*`
      if (op.hasExpansion && (recursive || force)) {
        addFinding(ctx, {
          risk: "block",
          category: "destructive_fs",
          reason: `Destructive 'rm' uses unverified variable expansion (${op.raw})`,
        });
        continue;
      }

      // Direct parent traversal `..` or `../..`
      if (
        raw === ".." ||
        raw.endsWith("/..") ||
        raw === "~" ||
        raw === "~/" ||
        raw === "/" ||
        raw === "/*"
      ) {
        recordPathTouch(raw, ctx);
        addFinding(ctx, {
          risk: "block",
          category: "destructive_fs",
          reason: `Destructive 'rm' targets critical or parent path (${raw})`,
        });
        continue;
      }

      // Handle wildcard suffix like `/workspace/*` or `./*`
      const strippedGlob = raw.endsWith("/*")
        ? raw.slice(0, -2) || "/"
        : raw;
      const resolved = recordPathTouch(strippedGlob, ctx);
      if (!resolved) continue;

      const sens = classifyPathSensitivity(resolved, ctx.homeDir);
      if (sens.isSecret) {
        addFinding(ctx, {
          risk: "block",
          category: "secrets",
          reason: `Removing sensitive file (${resolved})`,
        });
        continue;
      }

      if (!isWithinWorkspace(resolved, ctx.workspaceRoot)) {
        addFinding(ctx, {
          risk: "block",
          category: "destructive_fs",
          reason: `Filesystem deletion outside workspace root (${resolved})`,
        });
        continue;
      }

      if (isWorkspaceRootItself(resolved, ctx.workspaceRoot)) {
        addFinding(ctx, {
          risk: "block",
          category: "destructive_fs",
          reason: `Deleting entire workspace root (${resolved}) is blocked`,
        });
        continue;
      }

      // Inside workspace subdirectory/file -> safe when write is permitted
    }
    return;
  }

  // `dd` and raw block/filesystem formatting commands
  if (
    cmdBase === "mkfs" ||
    cmdBase.startsWith("mkfs.") ||
    cmdBase === "fdisk" ||
    cmdBase === "parted" ||
    cmdBase === "gdisk" ||
    cmdBase === "wipefs" ||
    cmdBase === "shred"
  ) {
    for (const v of argValues) {
      if (!v.startsWith("-")) recordPathTouch(v, ctx);
    }
    addFinding(ctx, {
      risk: "block",
      category: "destructive_fs",
      reason: `Low-level disk or filesystem destruction command '${cmdBase}' is blocked`,
    });
    return;
  }

  if (cmdBase === "dd") {
    let outFile: string | null = null;
    for (const v of argValues) {
      if (v.startsWith("if=")) recordPathTouch(v.slice(3), ctx);
      if (v.startsWith("of=")) {
        outFile = v.slice(3);
        recordPathTouch(outFile, ctx);
      }
    }
    const resolvedOut = outFile
      ? resolveCommandPath(outFile, ctx.cwd, ctx.homeDir)
      : null;
    if (
      !resolvedOut ||
      resolvedOut.startsWith("/dev/") ||
      !isWithinWorkspace(resolvedOut, ctx.workspaceRoot)
    ) {
      addFinding(ctx, {
        risk: "block",
        category: "destructive_fs",
        reason: `Raw block write via 'dd' targeting ${resolvedOut ?? "device/stdout"} is blocked`,
      });
    } else {
      addFinding(ctx, {
        risk: "review",
        category: "destructive_fs",
        reason: `Raw file write via 'dd' inside workspace (${resolvedOut})`,
      });
    }
    return;
  }

  // `chmod`
  if (cmdBase === "chmod") {
    let recursive = false;
    const positional: string[] = [];
    for (const v of argValues) {
      if (v === "-R" || v === "--recursive") recursive = true;
      else if (!v.startsWith("-")) positional.push(v);
    }
    const mode = positional[0] ?? "";
    const targets = positional.slice(1);
    const isWorldWritable777 =
      /^[0-7]?777$/.test(mode) ||
      /(?:^|,)(?:a|o)\+[rwx]*w/.test(mode) ||
      mode === "+w";
    const isSetuidOrSetgid =
      /^[2467][0-7]{3}$/.test(mode) || /(?:u|g|a)?\+s/.test(mode);

    if (isSetuidOrSetgid) {
      addFinding(ctx, {
        risk: "block",
        category: "privilege",
        reason: `Setting setuid/setgid permissions ('chmod ${mode}') is blocked`,
      });
    }

    if (isWorldWritable777 && recursive) {
      addFinding(ctx, {
        risk: "block",
        category: "destructive_fs",
        reason: `Recursive world-writable permissions ('chmod -R ${mode}') is blocked`,
      });
    } else if (isWorldWritable777) {
      addFinding(ctx, {
        risk: "block",
        category: "destructive_fs",
        reason: `World-writable permissions ('chmod ${mode}') is blocked`,
      });
    }

    for (const t of targets) {
      const resolved = recordPathTouch(t, ctx);
      if (resolved && !isWithinWorkspace(resolved, ctx.workspaceRoot)) {
        addFinding(ctx, {
          risk: "block",
          category: "destructive_fs",
          reason: `Changing permissions outside workspace (${resolved}) is blocked`,
        });
      }
    }
    return;
  }

  // `chown` / `chgrp`
  if (cmdBase === "chown" || cmdBase === "chgrp") {
    const positional = argValues.filter((v) => !v.startsWith("-"));
    const ownerSpec = positional[0] ?? "";
    const targets = positional.slice(1);
    for (const t of targets) {
      recordPathTouch(t, ctx);
    }
    const targetsOutside = targets.some((t) => {
      const res = resolveCommandPath(t, ctx.cwd, ctx.homeDir);
      return !isWithinWorkspace(res, ctx.workspaceRoot);
    });
    if (
      targetsOutside ||
      ownerSpec.startsWith("root") ||
      ownerSpec === "0" ||
      ownerSpec.startsWith("0:")
    ) {
      addFinding(ctx, {
        risk: "block",
        category: "destructive_fs",
        reason: `Ownership change ('${cmdBase} ${ownerSpec}') on root or outside workspace is blocked`,
      });
    } else {
      addFinding(ctx, {
        risk: "review",
        category: "destructive_fs",
        reason: `Changing file ownership via '${cmdBase} ${ownerSpec}'`,
      });
    }
    return;
  }

  // General path tracking & workspace boundary checks for `mv`, `cp`, `touch`, `mkdir`, `truncate`, `ln`, `tee`
  if (
    cmdBase === "mv" ||
    cmdBase === "cp" ||
    cmdBase === "touch" ||
    cmdBase === "mkdir" ||
    cmdBase === "truncate" ||
    cmdBase === "ln" ||
    cmdBase === "tee" ||
    cmdBase === "install"
  ) {
    const paths = argValues.filter((v) => !v.startsWith("-"));
    for (let idx = 0; idx < paths.length; idx++) {
      const p = paths[idx]!;
      const resolved = recordPathTouch(p, ctx);
      if (!resolved || isStandardDevice(resolved)) continue;

      const sens = classifyPathSensitivity(resolved, ctx.homeDir);
      if (sens.isPersistence) {
        addFinding(ctx, {
          risk: "block",
          category: "persistence",
          reason:
            sens.persistenceReason ??
            `Modifying persistence path (${resolved}) via '${cmdBase}'`,
        });
      }
      if (sens.isSecret) {
        addFinding(ctx, {
          risk: sens.secretSeverity ?? "block",
          category: "secrets",
          reason:
            sens.secretReason ??
            `Accessing secret path (${resolved}) via '${cmdBase}'`,
        });
      }

      // For `cp /outside/file ./inside`, reading non-secret outside file is review, writing outside is block/review
      const isDestArg =
        cmdBase === "touch" ||
        cmdBase === "mkdir" ||
        cmdBase === "truncate" ||
        cmdBase === "tee" ||
        idx === paths.length - 1 ||
        cmdBase === "mv";

      if (!isWithinWorkspace(resolved, ctx.workspaceRoot)) {
        if (isDestArg) {
          addFinding(ctx, {
            risk: isSystemCriticalPath(resolved) ? "block" : "review",
            category: "workspace_escape",
            reason: `File mutation outside workspace (${resolved}) via '${cmdBase}'`,
          });
        } else if (!sens.isSecret) {
          addFinding(ctx, {
            risk: "review",
            category: "workspace_escape",
            reason: `Copying file from outside workspace (${resolved})`,
          });
        }
      }
    }
    return;
  }

  // Track paths for `find`
  if (cmdBase === "find") {
    for (const v of argValues) {
      if (v.startsWith("-") || v === "(" || v === ")" || v === "!" || v === ";") {
        break;
      }
      const resolved = recordPathTouch(v, ctx);
      if (resolved && !isWithinWorkspace(resolved, ctx.workspaceRoot)) {
        addFinding(ctx, {
          risk: isFindDelete ? "block" : "review",
          category: isFindDelete ? "destructive_fs" : "workspace_escape",
          reason: `Searching filesystem outside workspace (${resolved})`,
        });
      }
    }
    return;
  }

  // Track paths for `sed -i` / `perl -i`
  if (isSedInPlace || isPerlInPlace) {
    const nonFlags = argValues.filter((v) => !v.startsWith("-"));
    // Skip first non-flag script expression
    const fileArgs = nonFlags.slice(1);
    for (const f of fileArgs) {
      const resolved = recordPathTouch(f, ctx);
      if (!resolved) continue;
      const sens = classifyPathSensitivity(resolved, ctx.homeDir);
      if (sens.isPersistence) {
        addFinding(ctx, {
          risk: "block",
          category: "persistence",
          reason:
            sens.persistenceReason ??
            `In-place edit of persistence file (${resolved})`,
        });
      }
      if (!isWithinWorkspace(resolved, ctx.workspaceRoot)) {
        addFinding(ctx, {
          risk: "block",
          category: "workspace_escape",
          reason: `In-place edit outside workspace (${resolved})`,
        });
      }
    }
  }

  void redirects;
}

function evaluateSecretsOnCommand(
  cmdBase: string,
  args: WordToken[],
  pipelineContext: {
    pipedToShell: boolean;
    pipedToNetwork: boolean;
    pipedFromNetwork: boolean;
  },
  ctx: AnalysisContext,
): void {
  if (!FILE_READ_COMMANDS.has(cmdBase) && cmdBase !== "ls" && cmdBase !== "find") {
    return;
  }

  for (const arg of args) {
    const v = arg.value;
    if (!v || v.startsWith("-")) continue;

    // Handle curl/openssl style `@/path/to/secret`
    const candidatePath = v.startsWith("@") ? v.slice(1) : v;
    if (!candidatePath) continue;

    // Skip obvious regex patterns in grep/rg/awk/sed first positional arg
    if (
      (cmdBase === "grep" ||
        cmdBase === "egrep" ||
        cmdBase === "fgrep" ||
        cmdBase === "rg" ||
        cmdBase === "awk" ||
        cmdBase === "sed") &&
      !candidatePath.includes("/") &&
      !candidatePath.startsWith(".") &&
      !candidatePath.startsWith("~")
    ) {
      continue;
    }

    const resolved = recordPathTouch(candidatePath, ctx);
    if (!resolved || isStandardDevice(resolved)) continue;

    const sens = classifyPathSensitivity(resolved, ctx.homeDir);
    if (sens.isSecret) {
      const severity =
        pipelineContext.pipedToNetwork || sens.secretSeverity === "block"
          ? "block"
          : "review";
      addFinding(ctx, {
        risk: severity,
        category: "secrets",
        reason:
          sens.secretReason ??
          `Reading sensitive credential or secret file (${resolved})`,
      });
    }
  }
}

function evaluateNetworkCommand(
  cmdBase: string,
  args: WordToken[],
  pipelineContext: {
    pipedToShell: boolean;
    pipedToNetwork: boolean;
    pipedFromNetwork: boolean;
  },
  ctx: AnalysisContext,
): void {
  const argValues = args.map((a) => a.value);

  // Check if command is `git` doing a network subcommand
  const isGitNetwork =
    cmdBase === "git" &&
    argValues.some((v) =>
      ["push", "pull", "fetch", "clone", "ls-remote", "submodule"].includes(v),
    );

  // Check if package manager is doing a network command
  const isPkgNetwork =
    (cmdBase === "npm" ||
      cmdBase === "yarn" ||
      cmdBase === "pnpm" ||
      cmdBase === "bun" ||
      cmdBase === "pip" ||
      cmdBase === "pip3" ||
      cmdBase === "cargo" ||
      cmdBase === "go") &&
    argValues.some((v) =>
      [
        "install",
        "i",
        "add",
        "ci",
        "update",
        "upgrade",
        "publish",
        "fetch",
        "download",
        "get",
      ].includes(v),
    );

  // Check python -m http.server / uploadserver
  const isPythonServer =
    (cmdBase === "python" || cmdBase === "python3") &&
    argValues.includes("-m") &&
    argValues.some((v) => v === "http.server" || v === "SimpleHTTPServer");

  const isNetworkCmd =
    NETWORK_COMMANDS.has(cmdBase) ||
    isGitNetwork ||
    isPkgNetwork ||
    isPythonServer;

  if (!isNetworkCmd) return;

  // Extract targets & inspect flags
  let hasUploadOrPostFlag = false;
  let attachesSecretFile = false;
  const extractedHosts: string[] = [];

  for (let i = 0; i < argValues.length; i++) {
    const v = argValues[i]!;

    // Check curl/wget upload or POST flags
    if (
      cmdBase === "curl" &&
      (v === "-d" ||
        v === "--data" ||
        v === "--data-raw" ||
        v === "--data-binary" ||
        v === "--data-urlencode" ||
        v === "-F" ||
        v === "--form" ||
        v === "-T" ||
        v === "--upload-file" ||
        v.startsWith("-d") ||
        v.startsWith("--data") ||
        v.startsWith("-F") ||
        v.startsWith("-T"))
    ) {
      hasUploadOrPostFlag = true;
      const payload =
        v === "-d" ||
        v === "--data" ||
        v === "--data-raw" ||
        v === "--data-binary" ||
        v === "--data-urlencode" ||
        v === "-F" ||
        v === "--form" ||
        v === "-T" ||
        v === "--upload-file"
          ? argValues[i + 1] ?? ""
          : v.replace(/^(?:-d|--data(?:-\w+)?=|-F|--form=|-T|--upload-file=)/, "");

      const atMatch = /@([^\s;,"']+)/.exec(payload);
      const filePart =
        atMatch?.[1] ??
        (v === "-T" || v === "--upload-file" ? payload : null);
      if (filePart) {
        const resolved = recordPathTouch(filePart, ctx);
        if (resolved) {
          const sens = classifyPathSensitivity(resolved, ctx.homeDir);
          if (sens.isSecret || !isWithinWorkspace(resolved, ctx.workspaceRoot)) {
            attachesSecretFile = true;
          }
        }
      }
    }

    if (
      cmdBase === "wget" &&
      (v.startsWith("--post-data") || v.startsWith("--post-file"))
    ) {
      hasUploadOrPostFlag = true;
    }

    // URL extraction anywhere in argument
    URL_EXTRACT_RE.lastIndex = 0;
    let urlMatch: RegExpExecArray | null;
    while ((urlMatch = URL_EXTRACT_RE.exec(v)) !== null) {
      const host = recordNetworkTarget(urlMatch[0], ctx);
      if (host) extractedHosts.push(host);
    }

    // nc / ncat / netcat / telnet / ssh / scp / rsync host targets
    if (
      (cmdBase === "nc" ||
        cmdBase === "ncat" ||
        cmdBase === "netcat" ||
        cmdBase === "telnet" ||
        cmdBase === "ssh" ||
        cmdBase === "sftp" ||
        cmdBase === "ping" ||
        cmdBase === "ping6" ||
        cmdBase === "dig" ||
        cmdBase === "nslookup" ||
        cmdBase === "host" ||
        cmdBase === "whois") &&
      !v.startsWith("-") &&
      !/^\d+$/.test(v)
    ) {
      // Skip option values like `-p 4444` or `-i key`
      const prev = argValues[i - 1];
      if (
        prev &&
        ["-p", "-i", "-o", "-l", "-w", "-c", "-b", "-s", "-F", "-J", "-L", "-R", "-D"].includes(
          prev,
        )
      ) {
        continue;
      }
      const host = recordNetworkTarget(v, ctx);
      if (host) extractedHosts.push(host);
    }

    if ((cmdBase === "scp" || cmdBase === "rsync") && !v.startsWith("-")) {
      if (SCP_TARGET_RE.test(v)) {
        const host = recordNetworkTarget(v, ctx);
        if (host) extractedHosts.push(host);
      } else {
        recordPathTouch(v, ctx);
      }
    }
  }

  // Enforce role.allowNetwork = false
  if (!ctx.role.allowNetwork) {
    addFinding(ctx, {
      risk: "block",
      category: "role",
      reason: `Network command '${cmdBase}' blocked because role.allowNetwork is false`,
    });
    return;
  }

  // Pipe-to-shell installer (e.g., `curl https://... | sh` or `wget -O- ... | bash`)
  if (pipelineContext.pipedToShell) {
    addFinding(ctx, {
      risk: "block",
      category: "network_exfil",
      reason: `Remote script execution ('${cmdBase}' piped directly into shell) is blocked`,
    });
    return;
  }

  if (attachesSecretFile) {
    addFinding(ctx, {
      risk: "block",
      category: "secrets",
      reason: `Uploading sensitive or out-of-workspace file via '${cmdBase}'`,
    });
    addFinding(ctx, {
      risk: "block",
      category: "network_exfil",
      reason: `'${cmdBase}' sends local file contents to a remote host`,
    });
    return;
  }

  const nonAllowlistedHosts = extractedHosts.filter(
    (h) => !isHostAllowlisted(h, ctx),
  );

  // Bidirectional / raw socket / file transfer tools to non-allowlisted hosts -> block
  if (
    cmdBase === "nc" ||
    cmdBase === "ncat" ||
    cmdBase === "netcat" ||
    cmdBase === "socat" ||
    cmdBase === "telnet" ||
    cmdBase === "scp" ||
    cmdBase === "sftp" ||
    cmdBase === "ftp" ||
    cmdBase === "ssh" ||
    (cmdBase === "rsync" && extractedHosts.length > 0)
  ) {
    if (nonAllowlistedHosts.length > 0 || extractedHosts.length === 0) {
      addFinding(ctx, {
        risk: "block",
        category: "network_exfil",
        reason: `Remote transfer or socket session via '${cmdBase}' to ${nonAllowlistedHosts.join(", ") || "remote host"} is blocked`,
      });
      return;
    }
  }

  // Data exfiltration via HTTP POST/PUT/upload to non-allowlisted host -> block
  if (
    (hasUploadOrPostFlag || pipelineContext.pipedFromNetwork) &&
    nonAllowlistedHosts.length > 0
  ) {
    addFinding(ctx, {
      risk: "block",
      category: "network_exfil",
      reason: `Outbound data upload via '${cmdBase}' to non-allowlisted host (${nonAllowlistedHosts.join(", ")})`,
    });
    return;
  }

  // Read-only curl/wget to non-allowlisted host -> review
  if (
    (cmdBase === "curl" || cmdBase === "wget" || cmdBase === "aria2c") &&
    nonAllowlistedHosts.length > 0
  ) {
    addFinding(ctx, {
      risk: "review",
      category: "network_exfil",
      reason: `Outbound HTTP request via '${cmdBase}' to external host (${nonAllowlistedHosts.join(", ")})`,
    });
  }
}

function evaluatePackageAndGit(
  cmdBase: string,
  args: WordToken[],
  ctx: AnalysisContext,
): void {
  const argValues = args.map((a) => a.value);

  // Package registry publishing
  if (
    (cmdBase === "npm" ||
      cmdBase === "yarn" ||
      cmdBase === "pnpm" ||
      cmdBase === "bun" ||
      cmdBase === "cargo" ||
      cmdBase === "poetry" ||
      cmdBase === "flit" ||
      cmdBase === "hatch" ||
      cmdBase === "uv" ||
      cmdBase === "helm") &&
    argValues.includes("publish")
  ) {
    addFinding(ctx, {
      risk: "block",
      category: "package_publish",
      reason: `Package publishing via '${cmdBase} publish' is blocked`,
    });
    return;
  }

  if (
    (cmdBase === "twine" && argValues.includes("upload")) ||
    (cmdBase === "gem" && argValues.includes("push")) ||
    (cmdBase === "docker" && argValues.includes("push")) ||
    (cmdBase === "gh" &&
      argValues.includes("release") &&
      argValues.includes("create")) ||
    (cmdBase === "dotnet" &&
      argValues.includes("nuget") &&
      argValues.includes("push")) ||
    ((cmdBase === "mvn" || cmdBase === "./mvnw") &&
      argValues.includes("deploy"))
  ) {
    addFinding(ctx, {
      risk: "block",
      category: "package_publish",
      reason: `Artifact or release publishing via '${cmdBase}' is blocked`,
    });
    return;
  }

  if (PUBLISH_COMMANDS.has(cmdBase) && argValues.includes("publish")) {
    addFinding(ctx, {
      risk: "block",
      category: "package_publish",
      reason: `Publishing via '${cmdBase}' is blocked`,
    });
    return;
  }

  // Git policy
  if (cmdBase === "git") {
    const subIdx = argValues.findIndex((v) => !v.startsWith("-"));
    const subCmd = subIdx >= 0 ? argValues[subIdx]! : "";
    const subArgs = subIdx >= 0 ? argValues.slice(subIdx + 1) : [];

    // Role check for mutating git commands
    const mutatingGit = new Set([
      "commit",
      "push",
      "pull",
      "merge",
      "rebase",
      "cherry-pick",
      "reset",
      "clean",
      "checkout",
      "switch",
      "stash",
      "apply",
      "am",
      "rm",
      "mv",
      "init",
      "clone",
    ]);

    if (
      mutatingGit.has(subCmd) &&
      (ctx.role.readOnly || !ctx.role.allowWrite)
    ) {
      addFinding(ctx, {
        risk: "block",
        category: "role",
        reason: `Git write operation 'git ${subCmd}' blocked by read-only/no-write role`,
      });
    }

    if (subCmd === "push") {
      const hasForce = subArgs.some(
        (a) =>
          a === "--force" ||
          a === "-f" ||
          a === "--force-with-lease" ||
          a.startsWith("--force-with-lease=") ||
          (a.startsWith("+") && a.length > 1),
      );

      if (hasForce) {
        addFinding(ctx, {
          risk: "block",
          category: "package_publish",
          reason: "Force-pushing git history ('git push --force') is blocked",
        });
        return;
      }

      const positional = subArgs.filter((a) => !a.startsWith("-"));
      // Check refspecs for protected branches (main, master, prod, production, release)
      const targetsProtected = positional.some((ref) => {
        const dest = ref.includes(":") ? ref.split(":").pop()! : ref;
        const cleanBranch = dest
          .replace(/^\+/, "")
          .replace(/^refs\/heads\//, "");
        return (
          cleanBranch === "main" ||
          cleanBranch === "master" ||
          cleanBranch === "prod" ||
          cleanBranch === "production" ||
          cleanBranch === "release"
        );
      });

      if (targetsProtected) {
        addFinding(ctx, {
          risk: "block",
          category: "package_publish",
          reason: `Pushing directly to protected branch (${positional.join(" ")}) is blocked`,
        });
        return;
      }

      // Pushing to a feature branch or default remote -> review
      addFinding(ctx, {
        risk: "review",
        category: "package_publish",
        reason: `Pushing commits to remote repository ('${`git push ${positional.join(" ")}`.trim()}') requires review`,
      });
    } else if (subCmd === "clean") {
      const hasForce = subArgs.some(
        (a) => a.startsWith("-") && a.includes("f"),
      );
      if (hasForce) {
        addFinding(ctx, {
          risk: "review",
          category: "destructive_fs",
          reason: "Removing untracked files via 'git clean -f' requires review",
        });
      }
    } else if (subCmd === "reset" && subArgs.includes("--hard")) {
      addFinding(ctx, {
        risk: "review",
        category: "destructive_fs",
        reason: "Discarding working tree changes via 'git reset --hard' requires review",
      });
    }
  }
}

/**
 * Safely decodes static base64 payloads if they decode to printable ASCII/UTF-8 shell text.
 */
export function tryDecodeStaticBase64(input: string): string | null {
  const compact = input.replace(/\s+/g, "");
  if (!BASE64_LITERAL_RE.test(compact)) return null;
  try {
    const buf = Buffer.from(compact, "base64");
    const decoded = buf.toString("utf8");
    // Verify printable text (allow common control chars \n, \r, \t)
    for (let i = 0; i < decoded.length; i++) {
      const code = decoded.charCodeAt(i);
      if (
        code < 9 ||
        (code > 13 && code < 32) ||
        code === 0xfffd
      ) {
        return null;
      }
    }
    return decoded.trim().length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Decodes C/printf-style `\xHH` and `\NNN` escape sequences into plain text for recursive inspection.
 */
export function decodeEscapedString(input: string): string {
  return input
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/\\([0-7]{1,3})/g, (_, oct: string) =>
      String.fromCharCode(parseInt(oct, 8) & 0xff),
    );
}
