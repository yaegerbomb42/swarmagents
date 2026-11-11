/**
 * Production leaf completion gates — only path that may set status=completed.
 * Hard checks are model-independent (artifacts + shell exit codes).
 */
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import type { DecompSessionRecord } from '@/lib/decompSessions';
import { ensureConstraints } from '@/lib/decompSessions';
import { ENGINE_URL } from '@/lib/config';

export type QualityBar = 'low' | 'medium' | 'high' | 'strict';
export type CandidateReason =
  | 'engine_finish'
  | 'chat_completion'
  | 'manual_complete'
  | 'manual_verify'
  | 'execution_limit';

export type GateKind = 'artifact' | 'shell' | 'llm' | 'runtime' | 'candidate';

export type GateResult = {
  id: string;
  kind: GateKind;
  hard: boolean;
  status: 'passed' | 'failed' | 'skipped' | 'warning';
  durationMs?: number;
  command?: string[];
  exitCode?: number;
  evidence?: string;
};

export type LeafValidationReport = {
  version: 1;
  qualityBar: QualityBar;
  candidateReason: CandidateReason;
  passed: boolean;
  hardFailures: string[];
  gates: GateResult[];
  startedAt: number;
  completedAt: number;
  receiptPath: string;
};

export type SoftVerifier = (args: {
  node: any;
  output: string;
}) => Promise<{ verdict: string; feedback: string; confidence: number } | null>;

const META_ONLY = /(\.swarm\/|README\.md$)/i;
const CODE_EXT = /\.(py|ts|tsx|js|jsx|go|rs|java|kt|c|cpp|h|cs|rb|php|swift)$/i;

/** Only verify/test leaves should hard-fail the whole workspace npm suite. */
export function leafRequiresShellProof(node: any): boolean {
  const text = [
    node?.label,
    node?.description,
    ...(Array.isArray(node?.acceptance_criteria) ? node.acceptance_criteria : []),
    ...(Array.isArray(node?.tags) ? node.tags : []),
  ]
    .map((x) => String(x || ''))
    .join(' ')
    .toLowerCase();
  return /\b(test|verify|smoke|qa|acceptance|npm\s*test|pytest|lint|typecheck)\b/.test(text);
}

function resolveQualityBar(session: DecompSessionRecord): QualityBar {
  const bar = ensureConstraints(session).qualityBar || 'medium';
  return (['low', 'medium', 'high', 'strict'] as QualityBar[]).includes(bar as QualityBar)
    ? (bar as QualityBar)
    : 'medium';
}

function realArtifacts(node: any, workspace: string): string[] {
  const files = Array.isArray(node.files_written) ? node.files_written : [];
  return files
    .map((f: string) => String(f || '').replace(/^\.\//, '').trim())
    .filter((f: string) => f && !META_ONLY.test(f) && !path.isAbsolute(f) && !f.includes('..'));
}

async function artifactGate(
  workspace: string,
  relPaths: string[]
): Promise<GateResult> {
  const started = Date.now();
  if (!relPaths.length) {
    return {
      id: 'artifact_integrity',
      kind: 'artifact',
      hard: true,
      status: 'failed',
      durationMs: Date.now() - started,
      evidence: 'No non-.swarm workspace artifacts',
    };
  }
  const root = path.resolve(workspace);
  for (const rel of relPaths.slice(0, 40)) {
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep) && abs !== root) {
      return {
        id: 'artifact_integrity',
        kind: 'artifact',
        hard: true,
        status: 'failed',
        durationMs: Date.now() - started,
        evidence: `Path escape rejected: ${rel}`,
      };
    }
    try {
      const st = await fs.stat(abs);
      if (!st.isFile() || st.size <= 0) {
        return {
          id: 'artifact_integrity',
          kind: 'artifact',
          hard: true,
          status: 'failed',
          durationMs: Date.now() - started,
          evidence: `Missing or empty: ${rel}`,
        };
      }
    } catch {
      return {
        id: 'artifact_integrity',
        kind: 'artifact',
        hard: true,
        status: 'failed',
        durationMs: Date.now() - started,
        evidence: `Not found: ${rel}`,
      };
    }
  }
  return {
    id: 'artifact_integrity',
    kind: 'artifact',
    hard: true,
    status: 'passed',
    durationMs: Date.now() - started,
    evidence: `${relPaths.length} artifact(s)`,
  };
}

async function runCmd(
  cwd: string,
  argv: string[],
  timeoutMs: number
): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    const push = (buf: Buffer) => {
      if (out.length < 4000) out += buf.toString('utf8');
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? 124 : code ?? 1,
        output: out.slice(0, 2000),
        timedOut,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, output: String(err.message || err).slice(0, 500), timedOut: false });
    });
  });
}

async function findNearestPackageJson(workspace: string, relFiles: string[]): Promise<string | null> {
  const root = path.resolve(workspace);
  const dirs = new Set<string>([root]);
  for (const rel of relFiles) {
    let dir = path.resolve(root, path.dirname(rel));
    while (dir.startsWith(root)) {
      dirs.add(dir);
      if (dir === root) break;
      dir = path.dirname(dir);
    }
  }
  // Prefer deepest package.json under touched paths
  let best: { depth: number; dir: string } | null = null;
  for (const dir of dirs) {
    try {
      await fs.access(path.join(dir, 'package.json'));
      const depth = dir.split(path.sep).length;
      if (!best || depth > best.depth) best = { depth, dir };
    } catch {
      /* none */
    }
  }
  return best?.dir ?? null;
}

async function discoverShellGates(
  workspace: string,
  relFiles: string[],
  bar: QualityBar,
  opts?: { shellHard?: boolean }
): Promise<{ argv: string[]; id: string; hard: boolean }[]> {
  if (bar === 'low') return [];

  const shellHard = opts?.shellHard !== false;
  const cmds: { argv: string[]; id: string; hard: boolean }[] = [];
  const pkgDir = await findNearestPackageJson(workspace, relFiles);
  if (pkgDir) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const scripts = pkg.scripts || {};
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const add = (script: string, hard: boolean) => {
        if (scripts[script])
          cmds.push({ argv: [npm, 'run', script, '--silent'], id: `npm_${script}`, hard: hard && shellHard });
      };
      if (bar === 'medium') {
        if (scripts.test) add('test', true);
        else if (scripts.typecheck) add('typecheck', true);
        else if (scripts.check) add('check', true);
        else if (scripts.lint) add('lint', true);
      } else {
        add('test', true);
        add('typecheck', true);
        add('check', true);
        add('lint', true);
        if (bar === 'strict') add('build', true);
        else if (scripts.build) cmds.push({ argv: [npm, 'run', 'build', '--silent'], id: 'npm_build', hard: false });
      }
      // Rewrite cwd-relative: run from pkgDir via wrapper — we pass cwd later
      return cmds.map((c) => ({ ...c, argv: c.argv, _cwd: pkgDir } as any));
    } catch {
      /* fall through */
    }
  }

  // Python / Go / Rust heuristics when code artifacts exist
  const hasPy = relFiles.some((f) => f.endsWith('.py'));
  const hasGo = relFiles.some((f) => f.endsWith('.go'));
  const hasRs = relFiles.some((f) => f.endsWith('.rs'));
  if (hasPy) {
    try {
      await fs.access(path.join(workspace, 'pytest.ini'));
      cmds.push({
        argv: ['python', '-m', 'pytest', '-q', '--tb=no'],
        id: 'pytest',
        hard: shellHard,
      });
    } catch {
      try {
        await fs.access(path.join(workspace, 'pyproject.toml'));
        cmds.push({
          argv: ['python', '-m', 'pytest', '-q', '--tb=no'],
          id: 'pytest',
          hard: shellHard,
        });
      } catch {
        /* optional */
      }
    }
  }
  if (hasGo) cmds.push({ argv: ['go', 'test', './...'], id: 'go_test', hard: shellHard });
  if (hasRs) cmds.push({ argv: ['cargo', 'test', '--quiet'], id: 'cargo_test', hard: shellHard });

  return cmds;
}

async function persistReceipt(
  workspace: string,
  node: any,
  report: LeafValidationReport
): Promise<void> {
  const swarm = path.join(workspace, '.swarm');
  await fs.mkdir(swarm, { recursive: true });
  const receiptPath = path.join(swarm, `leaf-${node.id || 'task'}.json`);
  let prev: Record<string, unknown> = {};
  try {
    prev = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  } catch {
    /* new */
  }
  const merged = {
    ...prev,
    task_id: node.id,
    label: node.label,
    candidate: false,
    validation: report,
    validation_passed: report.passed,
    status: report.passed ? 'completed' : 'failed',
  };
  await fs.writeFile(receiptPath, JSON.stringify(merged, null, 2), 'utf8');
  report.receiptPath = `.swarm/leaf-${node.id || 'task'}.json`;
}

/**
 * Run hard (+ optional soft) gates. Mutates node status to validating → completed|failed.
 */
export async function finalizeLeafCandidate(
  session: DecompSessionRecord,
  node: any,
  workspace: string,
  opts: {
    reason: CandidateReason;
    softVerifier?: SoftVerifier;
  }
): Promise<{
  passed: boolean;
  report: LeafValidationReport;
  repaired?: boolean;
  repair?: { scheduled: boolean; attempt: number; maxAttempts: number; reason: string };
}> {
  const startedAt = Date.now();
  const qualityBar = resolveQualityBar(session);
  const gates: GateResult[] = [];
  const hardFailures: string[] = [];

  node.status = 'validating';
  node.validation_attempts = Number(node.validation_attempts || 0) + 1;

  gates.push({
    id: 'completion_candidate',
    kind: 'candidate',
    hard: true,
    status: 'passed',
    evidence: opts.reason,
  });

  const artifacts = realArtifacts(node, workspace);
  const art = await artifactGate(workspace, artifacts);
  gates.push(art);
  if (art.status === 'failed') hardFailures.push(art.id);

  let shellCmds: { argv: string[]; id: string; hard: boolean; cwd?: string }[] = [];
  try {
    const discovered = await discoverShellGates(workspace, artifacts, qualityBar, {
      shellHard: leafRequiresShellProof(node) || qualityBar === 'strict',
    });
    shellCmds = discovered.map((c: any) => ({
      argv: c.argv,
      id: c.id,
      hard: c.hard,
      cwd: c._cwd || workspace,
    }));
  } catch (e: any) {
    gates.push({
      id: 'gate_runtime',
      kind: 'runtime',
      hard: true,
      status: 'failed',
      evidence: String(e?.message || e).slice(0, 400),
    });
    hardFailures.push('gate_runtime');
  }

  const hasCode = artifacts.some((f) => CODE_EXT.test(f));
  if (
    qualityBar === 'strict' &&
    hasCode &&
    shellCmds.filter((c) => c.hard).length === 0 &&
    !hardFailures.length
  ) {
    gates.push({
      id: 'no_automated_check_available',
      kind: 'shell',
      hard: true,
      status: 'failed',
      evidence: 'strict bar requires a discoverable test/lint/build command',
    });
    hardFailures.push('no_automated_check_available');
  } else if (qualityBar === 'medium' && shellCmds.length === 0) {
    gates.push({
      id: 'shell_suite',
      kind: 'shell',
      hard: false,
      status: 'warning',
      evidence: 'No package scripts found — artifact-only pass',
    });
  }

  const totalTimeout = qualityBar === 'strict' ? 180_000 : 120_000;
  let spent = 0;
  for (const cmd of shellCmds) {
    if (hardFailures.length) break;
    if (spent >= totalTimeout) {
      gates.push({
        id: 'gate_runtime',
        kind: 'runtime',
        hard: true,
        status: 'failed',
        evidence: 'Validation total timeout',
      });
      hardFailures.push('gate_runtime');
      break;
    }
    const per = Math.min(60_000, totalTimeout - spent);
    const t0 = Date.now();
    const res = await runCmd(cmd.cwd || workspace, cmd.argv, per);
    spent += Date.now() - t0;
    const ok = res.exitCode === 0 && !res.timedOut;
    const g: GateResult = {
      id: cmd.id,
      kind: 'shell',
      hard: cmd.hard,
      status: ok ? 'passed' : cmd.hard ? 'failed' : 'warning',
      durationMs: Date.now() - t0,
      command: cmd.argv,
      exitCode: res.exitCode,
      evidence: res.output.slice(0, 800) || (res.timedOut ? 'timed out' : `exit ${res.exitCode}`),
    };
    gates.push(g);
    if (!ok && cmd.hard) hardFailures.push(cmd.id);
  }

  // Soft LLM verifier — never overrides hard pass
  const wantSoft =
    Boolean(opts.softVerifier) &&
    (qualityBar === 'high' || qualityBar === 'strict' || opts.reason === 'manual_verify');
  if (wantSoft && opts.softVerifier && !hardFailures.length) {
    try {
      const soft = await opts.softVerifier({
        node,
        output: String(node.result || '').slice(0, 3000),
      });
      if (soft) {
        const pass = soft.verdict === 'pass' || soft.verdict === 'minor_fixes';
        gates.push({
          id: 'llm_verifier',
          kind: 'llm',
          hard: false,
          status: pass ? 'passed' : 'warning',
          evidence: `${soft.verdict} (${soft.confidence}): ${soft.feedback}`.slice(0, 600),
        });
        node.validation_feedback = soft.feedback;
      }
    } catch (e: any) {
      gates.push({
        id: 'llm_verifier',
        kind: 'llm',
        hard: false,
        status: 'warning',
        evidence: `verifier unavailable: ${String(e?.message || e).slice(0, 200)}`,
      });
    }
  }

  const passed = hardFailures.length === 0;
  const report: LeafValidationReport = {
    version: 1,
    qualityBar,
    candidateReason: opts.reason,
    passed,
    hardFailures,
    gates,
    startedAt,
    completedAt: Date.now(),
    receiptPath: `.swarm/leaf-${node.id || 'task'}.json`,
  };

  node.validation_report = report;
  node.validation_passed = passed;
  node.validatedAt = report.completedAt;
  if (!node.validation_feedback) {
    node.validation_feedback = passed
      ? `Gates passed (${qualityBar})`
      : `Hard gate failures: ${hardFailures.join(', ')}`;
  }

  try {
    await persistReceipt(workspace, node, report);
  } catch {
    /* non-fatal */
  }

  if (passed) {
    node.status = 'completed';
    node.completedAt = report.completedAt;
    node.quality_score = Math.max(Number(node.quality_score) || 0, 0.85);
    // Clear repair markers on success
    if (node.purpose && String(node.purpose).startsWith('gate_repair_')) {
      node.purpose = undefined;
    }
    try {
      const { recordLeafValidated } = await import('@/lib/sessionWorldModel');
      await recordLeafValidated(workspace, session, node, report);
      // Best-effort mirror into engine WorldModelGraph (same file path)
      try {
        const engineUrl = ENGINE_URL.replace(/\/$/, '');
        await fetch(`${engineUrl}/world/record_leaf`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspace_path: workspace,
            session_id: session.id,
            leaf_id: node.id,
            label: node.label || node.id,
            artifacts: node.files_written || [],
            quality_bar: report.qualityBar,
            receipt_path: report.receiptPath,
            validated_at: report.completedAt,
          }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        /* engine optional — dashboard file is source of truth */
      }
      // Mirror verified ownership into project context
      try {
        const { loadProjectContext, saveProjectContext } = await import('@/lib/projectContext');
        const ctx = await loadProjectContext(workspace, session);
        const files = Array.isArray(node.files_written) ? node.files_written : [];
        for (const f of files.slice(0, 40)) {
          const rel = String(f || '');
          if (rel && !rel.includes('.swarm/')) {
            ctx.ownership[rel] = String(node.assignedAgent || node.label || node.id);
          }
        }
        const decision = `Validated leaf “${node.label || node.id}” (${report.qualityBar})`;
        if (!ctx.decisions.includes(decision)) ctx.decisions.push(decision);
        ctx.decisions = ctx.decisions.slice(-40);
        await saveProjectContext(workspace, ctx);
      } catch {
        /* optional */
      }
    } catch {
      /* non-fatal — gates already passed */
    }
    return { passed, report, repaired: false };
  }

  node.status = 'failed';
  node.completedAt = undefined;
  node.quality_score = Math.min(Number(node.quality_score) || 0.4, 0.45);
  node.last_error = node.validation_feedback;

  const { maybeScheduleLeafRepair } = await import('@/lib/leafRepairLoop');
  const decision = maybeScheduleLeafRepair(session, node, report);
  return {
    passed: false,
    report,
    repaired: decision.scheduled,
    repair: decision,
  };
}

/** Clear validation so an explicit re-run can become a fresh candidate. */
export function resetLeafValidation(node: any): void {
  node.validation_passed = null;
  node.validation_feedback = '';
  node.validation_report = undefined;
  node.validatedAt = undefined;
  node.watcher_checked = false;
  node.watcher_retried = false;
  node.repair_attempts = 0;
  node.repair_history = [];
  node.last_repair_brief = undefined;
  if (node.purpose && String(node.purpose).startsWith('gate_repair_')) {
    node.purpose = undefined;
  }
  // Strip prior repair brief from description
  const desc = String(node.description || '');
  if (desc.includes('[GATE_REPAIR_BRIEF]')) {
    node.description = desc.replace(/^\[GATE_REPAIR_BRIEF\][\s\S]*?\n---\n/, '');
  }
}

export function leafBatchTerminalStats(leaves: any[]): {
  remaining: number;
  completed: number;
  failed: number;
  total: number;
  done: boolean;
  terminal: boolean;
} {
  const total = leaves.length;
  const completed = leaves.filter(
    (n) => n.status === 'completed' && n.validation_passed !== false
  ).length;
  const failed = leaves.filter((n) => n.status === 'failed').length;
  const remaining = leaves.filter(
    (n) => !['completed', 'failed'].includes(String(n.status))
  ).length;
  const terminal = remaining === 0;
  const done =
    terminal &&
    failed === 0 &&
    total > 0 &&
    leaves.every((n) => n.status === 'completed' && n.validation_passed !== false);
  return { remaining, completed, failed, total, done, terminal };
}
