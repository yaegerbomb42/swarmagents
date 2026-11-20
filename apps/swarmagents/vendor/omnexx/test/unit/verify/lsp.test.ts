import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PersistentLspClient } from '../../../src/verify/lsp/client.js';
import { LspClientManager, lspClientManager } from '../../../src/verify/lsp/manager.js';

function frame(obj: unknown): string {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

describe('PersistentLspClient with mock JSON-RPC streams', () => {
  it('correlates request/response and returns result', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new PersistentLspClient({
      root: '/tmp/proj',
      language: 'python',
      input,
      output,
      timeoutMs: 1000,
    });
    const startPromise = client.start();
    setTimeout(() => {
      input.write(frame({ jsonrpc: '2.0', id: 1, result: {} }));
    }, 10);
    await startPromise;

    const reqPromise = client.request('textDocument/diagnostic', {
      textDocument: { uri: 'file:///a.py' },
    });
    setTimeout(() => {
      input.write(frame({ jsonrpc: '2.0', id: 2, result: { items: [] } }));
    }, 10);
    const res = await reqPromise;
    expect(res).toEqual({ items: [] });
    await client.close();
  });

  it('times out when no response', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new PersistentLspClient({
      root: '/tmp/proj',
      language: 'rust',
      input,
      output,
      timeoutMs: 50,
    });
    await client.start();
    await expect(client.request('foo/bar', {})).rejects.toThrow(/timed out/);
    await client.close();
  });

  it('handles publishDiagnostics notifications', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new PersistentLspClient({
      root: '/tmp/proj',
      language: 'python',
      input,
      output,
      timeoutMs: 1000,
    });
    const received: { uri: string; diags: unknown[] }[] = [];
    client.onDiagnostics((uri, diags) => received.push({ uri, diags }));
    await client.start();
    input.write(
      frame({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri: 'file:///a.py',
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              severity: 1,
              code: 'E1',
              message: 'boom',
            },
          ],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(received.length).toBe(1);
    expect((received[0] as { diags: unknown[] }).diags.length).toBe(1);
    await client.close();
  });

  it('manager maintains map by root:language', () => {
    const m = new LspClientManager();
    const c1 = m.get('/r', 'python', { input: new PassThrough(), output: new PassThrough() });
    const c2 = m.get('/r', 'python');
    expect(c1).toBe(c2);
    expect(m.key('/r', 'python')).toBe('/r:python');
    expect(m.size).toBe(1);
  });

  it('singleton manager exists', () => {
    expect(lspClientManager).toBeInstanceOf(LspClientManager);
  });
});
