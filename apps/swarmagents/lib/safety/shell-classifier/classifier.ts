import {
  formatNormalizedPipelines,
  parseBashTokens,
} from "./parser";
import { normalizePosixPath } from "./paths";
import {
  addFinding,
  basenameCmd,
  decodeEscapedString,
  DEFAULT_ALLOWLISTED_HOSTS,
  evaluateForkBombNode,
  evaluateRedirects,
  evaluateSimpleCommand,
  SHELL_BINARIES,
  TRANSPARENT_WRAPPERS,
  tryDecodeStaticBase64,
} from "./rules";
import { tokenizeBash } from "./tokenizer";
import {
  type AnalysisContext,
  type ClassifyInput,
  type ClassifyOutput,
  ClassifyInputSchema,
  type CommandNode,
  type PipelineNode,
  type RiskLevel,
  type SimpleCommandNode,
  type WordToken,
} from "./types";

const MAX_RECURSION_DEPTH = 8;

const RISK_RANK: Record<RiskLevel, number> = {
  safe: 0,
  review: 1,
  block: 2,
};

const NETWORK_PIPE_RECEIVERS = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "ssh",
  "scp",
  "rsync",
  "ftp",
  "sftp",
  "telnet",
]);

function makeWord(val: string): WordToken {
  return {
    raw: val,
    value: val,
    hasQuotes: false,
    singleQuoted: false,
    midWordQuoted: false,
    hasExpansion: false,
    hasHexOrOctalEscape: false,
    subcommands: [],
    variables: [],
  };
}

/**
 * Strips transparent execution prefixes (`command`, `nohup`, `nice`, `timeout 10`, `env VAR=1`)
 * and returns the effective command argv plus extracted inner commands from `sh -c`, `eval`, `xargs`, `find -exec`.
 */
function unwrapCommandAndExtractNested(
  cmd: SimpleCommandNode,
  ctx: AnalysisContext,
): {
  effectiveArgv: WordToken[];
  nestedScripts: string[];
  nestedArgvs: WordToken[][];
} {
  const nestedScripts: string[] = [];
  const nestedArgvs: WordToken[][] = [];

  // 1. Collect all command substitutions $(...), `...`, <(...), >(...) inside env assignments, argv, and redirects
  for (const env of cmd.envAssignments) {
    nestedScripts.push(...env.value.subcommands);
  }
  for (const arg of cmd.argv) {
    nestedScripts.push(...arg.subcommands);
  }
  for (const redir of cmd.redirects) {
    nestedScripts.push(...redir.target.subcommands);
  }

  let idx = 0;
  const argv = cmd.argv;

  // Unwrap transparent wrappers (command, nohup, nice, timeout, env)
  while (idx < argv.length) {
    const headBase = basenameCmd(argv[idx]!.value);

    if (TRANSPARENT_WRAPPERS.has(headBase)) {
      idx++;
      // Skip wrapper flags (e.g., `nice -n 10`, `command -p`, `stdbuf -o0`)
      while (idx < argv.length && argv[idx]!.value.startsWith("-")) {
        const flag = argv[idx]!.value;
        idx++;
        if (
          (flag === "-n" || flag === "-o" || flag === "-e" || flag === "-i") &&
          idx < argv.length
        ) {
          idx++;
        }
      }
      continue;
    }

    if (headBase === "timeout") {
      idx++;
      while (idx < argv.length && argv[idx]!.value.startsWith("-")) {
        const flag = argv[idx]!.value;
        idx++;
        if (
          (flag === "-s" || flag === "-k" || flag === "--signal" || flag === "--kill-after") &&
          idx < argv.length
        ) {
          idx++;
        }
      }
      // Duration argument (e.g., `10`, `5s`)
      if (idx < argv.length && /^\d+[smhd]?$/.test(argv[idx]!.value)) {
        idx++;
      }
      continue;
    }

    if (headBase === "env") {
      // Only unwrap `env` if followed by a command (not bare `env` dump)
      let look = idx + 1;
      while (look < argv.length) {
        const v = argv[look]!.value;
        if (v === "-i" || v === "--ignore-environment" || v === "-0" || v === "--null") {
          look++;
        } else if (v === "-u" || v === "--unset" || v === "-C" || v === "--chdir") {
          look += 2;
        } else if (/^[a-zA-Z_][a-zA-Z0-9_]*=/.test(v)) {
          look++;
        } else {
          break;
        }
      }
      if (look < argv.length) {
        idx = look;
        continue;
      }
    }

    break;
  }

  const effectiveArgv = argv.slice(idx);
  if (effectiveArgv.length === 0) {
    return { effectiveArgv, nestedScripts, nestedArgvs };
  }

  const headBase = basenameCmd(effectiveArgv[0]!.value);

  // 2. Shell re-entry: `sh -c "..."`, `bash -lc "..."`, `zsh -ec "..."`
  if (SHELL_BINARIES.has(headBase)) {
    for (let i = 1; i < effectiveArgv.length; i++) {
      const flag = effectiveArgv[i]!.value;
      if (flag === "--") break;
      if (
        flag.startsWith("-") &&
        !flag.startsWith("--") &&
        flag.includes("c")
      ) {
        const scriptTok = effectiveArgv[i + 1];
        if (scriptTok) {
          nestedScripts.push(scriptTok.value);
        }
        break;
      }
    }
    // Check heredoc piped directly into shell (`bash <<EOF ... EOF`)
    for (const r of cmd.redirects) {
      if ((r.op === "<<" || r.op === "<<-") && r.heredocBody) {
        nestedScripts.push(r.heredocBody);
      }
    }
  }

  // 3. `eval ...` re-entry
  if (headBase === "eval") {
    const evalArgs = effectiveArgv.slice(1);
    if (evalArgs.length > 0) {
      const hasDynamicVar = evalArgs.some(
        (a) => a.hasExpansion && a.subcommands.length === 0,
      );
      if (hasDynamicVar) {
        addFinding(ctx, {
          risk: "block",
          category: "obfuscation",
          reason: "Dynamic code execution via 'eval' with variable expansion",
        });
      }
      nestedScripts.push(evalArgs.map((a) => a.value).join(" "));
    }
  }

  // 4. `sudo [flags] <inner_cmd>` re-entry (in addition to blocking sudo itself)
  if (headBase === "sudo" || headBase === "doas" || headBase === "pkexec") {
    let i = 1;
    while (i < effectiveArgv.length && effectiveArgv[i]!.value.startsWith("-")) {
      const flag = effectiveArgv[i]!.value;
      i++;
      if (
        (flag === "-u" || flag === "-g" || flag === "-C" || flag === "-h" || flag === "-p") &&
        i < effectiveArgv.length
      ) {
        i++;
      }
    }
    if (i < effectiveArgv.length) {
      nestedArgvs.push(effectiveArgv.slice(i));
    }
  }

  // 5. `su [-c <script>]` re-entry
  if (headBase === "su") {
    for (let i = 1; i < effectiveArgv.length; i++) {
      const v = effectiveArgv[i]!.value;
      if ((v === "-c" || v === "--command") && effectiveArgv[i + 1]) {
        nestedScripts.push(effectiveArgv[i + 1]!.value);
      }
    }
  }

  // 6. `xargs [flags] <cmd> [args...]` re-entry
  if (headBase === "xargs") {
    let i = 1;
    while (i < effectiveArgv.length) {
      const v = effectiveArgv[i]!.value;
      if (v === "--") {
        i++;
        break;
      }
      if (!v.startsWith("-")) break;
      i++;
      // Flags that take a separate argument
      if (
        [
          "-I",
          "-L",
          "-n",
          "-P",
          "-s",
          "-d",
          "-E",
          "-a",
          "--replace",
          "--max-args",
          "--max-procs",
          "--delimiter",
          "--arg-file",
        ].includes(v) &&
        i < effectiveArgv.length
      ) {
        i++;
      }
    }
    if (i < effectiveArgv.length) {
      const innerArgv = effectiveArgv.slice(i);
      const innerHead = basenameCmd(innerArgv[0]!.value);
      // Guard: `xargs rm -rf` with no explicit target operand receives dynamic stdin paths
      if (innerHead === "rm" && innerArgv.length <= 2) {
        const hasRecursive = innerArgv
          .slice(1)
          .some((a) => a.value.startsWith("-") && (a.value.includes("r") || a.value.includes("R")));
        if (hasRecursive) {
          addFinding(ctx, {
            risk: "review",
            category: "destructive_fs",
            reason: "Recursive 'rm -rf' via xargs targets dynamic stdin paths",
          });
        }
      }
      nestedArgvs.push(innerArgv);
    }
  }

  // 7. `find ... -exec / -execdir / -ok / -okdir <cmd> ... ;/+` re-entry
  if (headBase === "find") {
    for (let i = 1; i < effectiveArgv.length; i++) {
      const v = effectiveArgv[i]!.value;
      if (
        v === "-exec" ||
        v === "-execdir" ||
        v === "-ok" ||
        v === "-okdir"
      ) {
        const execTokens: WordToken[] = [];
        let j = i + 1;
        while (j < effectiveArgv.length) {
          const tok = effectiveArgv[j]!;
          if (tok.value === ";" || tok.value === "+") {
            break;
          }
          // Replace `{}` placeholder with a benign local path inside workspace for evaluation
          if (tok.value === "{}") {
            execTokens.push(makeWord("./__find_match__"));
          } else {
            execTokens.push(tok);
          }
          j++;
        }
        if (execTokens.length > 0) {
          nestedArgvs.push(execTokens);
        }
        i = j;
      }
    }
  }

  // 8. `source <file>` or `. <file>`
  if (headBase === "source" || headBase === ".") {
    const targetFile = effectiveArgv[1];
    if (targetFile) {
      addFinding(ctx, {
        risk: "review",
        category: "execution",
        reason: `Sourcing external script '${targetFile.value}' into current shell`,
      });
    }
  }

  return { effectiveArgv, nestedScripts, nestedArgvs };
}

function analyzePipelines(
  pipelines: PipelineNode[],
  ctx: AnalysisContext,
): void {
  if (ctx.depth > MAX_RECURSION_DEPTH) {
    addFinding(ctx, {
      risk: "block",
      category: "obfuscation",
      reason: `Command nesting depth exceeded maximum limit (${MAX_RECURSION_DEPTH})`,
    });
    return;
  }

  for (const pipeline of pipelines) {
    const segs = pipeline.segments;

    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      const nextSeg = segs[i + 1];
      const prevSeg = i > 0 ? segs[i - 1] : undefined;

      const nextHead =
        nextSeg?.command.kind === "simple"
          ? basenameCmd(nextSeg.command.argv[0]?.value ?? "")
          : "";
      const prevHead =
        prevSeg?.command.kind === "simple"
          ? basenameCmd(prevSeg.command.argv[0]?.value ?? "")
          : "";

      const pipedToShell =
        SHELL_BINARIES.has(nextHead) ||
        nextHead === "eval" ||
        nextHead === "python" ||
        nextHead === "python3" ||
        nextHead === "perl" ||
        nextHead === "ruby" ||
        nextHead === "node";

      const pipedToNetwork = NETWORK_PIPE_RECEIVERS.has(nextHead);
      const pipedFromNetwork =
        prevHead === "curl" ||
        prevHead === "wget" ||
        prevHead === "nc" ||
        prevHead === "ncat";

      // If literal data is piped into a shell (e.g., `echo "rm -rf /" | sh` or `echo "cm0gLXJmIC8=" | base64 -d | sh`),
      // extract and recursively analyze the literal payload!
      if (seg.command.kind === "simple") {
        extractPipedPayload(seg.command, segs.slice(i + 1), ctx);
      }

      analyzeCommandNode(
        seg.command,
        { pipedToShell, pipedToNetwork, pipedFromNetwork },
        ctx,
      );
    }
  }
}

function extractPipedPayload(
  producer: SimpleCommandNode,
  downstream: PipelineNode["segments"],
  ctx: AnalysisContext,
): void {
  if (downstream.length === 0) return;
  const producerBase = basenameCmd(producer.argv[0]?.value ?? "");
  if (producerBase !== "echo" && producerBase !== "printf") return;

  const literalArgs = producer.argv
    .slice(1)
    .filter((a) => !a.value.startsWith("-"))
    .map((a) => a.value);
  if (literalArgs.length === 0) return;

  let payload = literalArgs.join(" ");
  if (producerBase === "printf" || producer.argv.some((a) => a.value === "-e")) {
    payload = decodeEscapedString(payload);
  }

  for (const step of downstream) {
    if (step.command.kind !== "simple") break;
    const stepBase = basenameCmd(step.command.argv[0]?.value ?? "");

    if (
      stepBase === "base64" &&
      step.command.argv.some((a) => a.value === "-d" || a.value === "--decode")
    ) {
      const decoded = tryDecodeStaticBase64(payload);
      if (!decoded) return;
      payload = decoded;
      continue;
    }

    if (stepBase === "rev") {
      payload = payload.split("").reverse().join("");
      continue;
    }

    if (SHELL_BINARIES.has(stepBase) || stepBase === "eval") {
      recurseScript(payload, ctx);
      return;
    }
  }
}

function analyzeCommandNode(
  node: CommandNode,
  pipelineContext: {
    pipedToShell: boolean;
    pipedToNetwork: boolean;
    pipedFromNetwork: boolean;
  },
  ctx: AnalysisContext,
): void {
  if (node.kind === "function") {
    evaluateForkBombNode(node, ctx);
    analyzeCommandNode(node.body, pipelineContext, ctx);
    return;
  }

  if (node.kind === "subshell" || node.kind === "group") {
    evaluateRedirects(node.redirects, ctx);
    analyzePipelines(node.pipelines, ctx);
    return;
  }
  if (node.kind !== "simple") return;

  // SimpleCommandNode
  // Track literal variable assignments in scope (`a=rm`, `CMD="curl ..."`)
  for (const env of node.envAssignments) {
    if (!env.value.hasExpansion && env.value.subcommands.length === 0) {
      ctx.vars.set(env.name, env.value.value);
    }
  }

  evaluateRedirects(node.redirects, ctx);

  const { effectiveArgv, nestedScripts, nestedArgvs } =
    unwrapCommandAndExtractNested(node, ctx);

  evaluateSimpleCommand(node, effectiveArgv, pipelineContext, ctx);

  for (const innerArgv of nestedArgvs) {
    const syntheticCmd: SimpleCommandNode = {
      kind: "simple",
      envAssignments: [],
      argv: innerArgv,
      redirects: [],
    };
    const nextCtx: AnalysisContext = { ...ctx, depth: ctx.depth + 1 };
    if (nextCtx.depth > MAX_RECURSION_DEPTH) {
      addFinding(ctx, {
        risk: "block",
        category: "obfuscation",
        reason: `Command nesting depth exceeded maximum limit (${MAX_RECURSION_DEPTH})`,
      });
      return;
    }
    analyzeCommandNode(syntheticCmd, pipelineContext, nextCtx);
  }

  // Process substitution fed to an interpreter (`bash <(curl ...)`) is the
  // same as piping into it, so analyze it as `<inner> | sh`.
  const headBase = basenameCmd(effectiveArgv[0]?.value ?? "");
  const feedsInterpreter =
    SHELL_BINARIES.has(headBase) || headBase === "source" || headBase === ".";
  const procSubScripts = new Set<string>();
  if (feedsInterpreter) {
    for (const arg of effectiveArgv.slice(1)) {
      if (arg.raw.startsWith("<(")) {
        for (const sub of arg.subcommands) procSubScripts.add(sub);
      }
    }
  }

  for (const script of nestedScripts) {
    recurseScript(procSubScripts.has(script) ? `${script} | sh` : script, ctx);
  }
}

function recurseScript(script: string, ctx: AnalysisContext): void {
  const trimmed = script.trim();
  if (!trimmed) return;

  const nextCtx: AnalysisContext = {
    ...ctx,
    depth: ctx.depth + 1,
    vars: new Map(ctx.vars),
  };

  if (nextCtx.depth > MAX_RECURSION_DEPTH) {
    addFinding(ctx, {
      risk: "block",
      category: "obfuscation",
      reason: `Command nesting depth exceeded maximum limit (${MAX_RECURSION_DEPTH})`,
    });
    return;
  }

  const tokens = tokenizeBash(trimmed);
  const ast = parseBashTokens(tokens);
  analyzePipelines(ast, nextCtx);
}

export function classifyCommand(rawInput: ClassifyInput): ClassifyOutput {
  const parsed = ClassifyInputSchema.parse(rawInput);

  const allowlistedHosts = new Set<string>();
  const allowlistedWildcards: string[] = [];

  const hostSource = parsed.allowlistedHosts ?? DEFAULT_ALLOWLISTED_HOSTS;
  for (const h of hostSource) {
    const clean = h.trim().toLowerCase();
    if (!clean) continue;
    if (clean.startsWith("*.")) {
      allowlistedWildcards.push(clean.slice(1)); // ".localhost"
    } else {
      allowlistedHosts.add(clean);
    }
  }

  const homeDir = normalizePosixPath(
    parsed.homeDir ?? process.env.HOME ?? "/home/user",
  );
  const workspaceRoot = normalizePosixPath(parsed.workspaceRoot);
  const cwd = normalizePosixPath(
    parsed.cwd.startsWith("/")
      ? parsed.cwd
      : `${workspaceRoot}/${parsed.cwd}`,
  );

  const ctx: AnalysisContext = {
    cwd,
    workspaceRoot,
    homeDir,
    role: parsed.role,
    allowlistedHosts,
    allowlistedWildcards,
    depth: 0,
    vars: new Map<string, string>(),
    findings: [],
    touchesPaths: new Set<string>(),
    networkTargets: new Set<string>(),
  };

  const tokens = tokenizeBash(parsed.command);
  const ast = parseBashTokens(tokens);
  const normalized = formatNormalizedPipelines(ast);

  // Role gate: allowBash = false blocks any non-empty command immediately
  if (!parsed.role.allowBash && normalized.length > 0) {
    addFinding(ctx, {
      risk: "block",
      category: "role",
      reason: "Bash execution is disabled for this role (allowBash=false)",
    });
  }

  analyzePipelines(ast, ctx);

  // Aggregate final risk, deduplicated reasons, categories, paths, and targets
  let highestRisk: RiskLevel = "safe";
  const reasonSet = new Set<string>();
  const categorySet = new Set<string>();

  for (const f of ctx.findings) {
    if (RISK_RANK[f.risk] > RISK_RANK[highestRisk]) {
      highestRisk = f.risk;
    }
    reasonSet.add(f.reason);
    categorySet.add(f.category);
  }

  return {
    risk: highestRisk,
    reasons: Array.from(reasonSet),
    categories: Array.from(categorySet),
    normalized,
    touchesPaths: Array.from(ctx.touchesPaths),
    networkTargets: Array.from(ctx.networkTargets),
  };
}
