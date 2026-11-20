import { lspClientManager } from './manager.js';
import type { Diagnostic } from '../preflight-types.js';

export function rustAnalyzerCommand(): string {
  return process.env.RUST_ANALYZER ?? 'rust-analyzer';
}

export function createRustAnalyzerClient(
  root: string,
  options?: { timeoutMs?: number; command?: string; args?: string[] },
) {
  return lspClientManager.get(root, 'rust', {
    command: options?.command ?? rustAnalyzerCommand(),
    args: options?.args ?? [],
    timeoutMs: options?.timeoutMs ?? 3_000,
    env: { RUST_ANALYZER_CHECK_ON_SAVE: 'true' },
  });
}

export function getRustAnalyzerClient(
  root: string,
  options?: { timeoutMs?: number; command?: string; args?: string[] },
) {
  return createRustAnalyzerClient(root, options);
}

export async function runRustDiagnostics(
  root: string,
  file: string,
  opts?: { timeoutMs?: number },
): Promise<Diagnostic[]> {
  const client = createRustAnalyzerClient(root, { timeoutMs: opts?.timeoutMs ?? 3_000 });
  if (!client.isStarted) await client.start();
  const uri = `file://${file.startsWith('/') ? file : `${root}/${file}`}`;
  return client.diagnostics(uri, opts?.timeoutMs ?? 3_000);
}
