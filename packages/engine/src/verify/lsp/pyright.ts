import { lspClientManager } from './manager.js';
import type { Diagnostic } from '../preflight-types.js';

export function pyrightCommand(): string {
  return process.env.PYRIGHT_LANGSERVER ?? 'pyright-langserver';
}

export function createPyrightClient(
  root: string,
  options?: { timeoutMs?: number; command?: string; args?: string[] },
) {
  return lspClientManager.get(root, 'python', {
    command: options?.command ?? pyrightCommand(),
    args: options?.args ?? ['--stdio'],
    timeoutMs: options?.timeoutMs ?? 3_000,
  });
}

export function getPyrightClient(
  root: string,
  options?: { timeoutMs?: number; command?: string; args?: string[] },
) {
  return createPyrightClient(root, options);
}

export async function runPyrightDiagnostics(
  root: string,
  file: string,
  opts?: { timeoutMs?: number },
): Promise<Diagnostic[]> {
  const client = createPyrightClient(root, { timeoutMs: opts?.timeoutMs ?? 3_000 });
  if (!client.isStarted) await client.start();
  const uri = `file://${file.startsWith('/') ? file : `${root}/${file}`}`;
  return client.diagnostics(uri, opts?.timeoutMs ?? 3_000);
}
