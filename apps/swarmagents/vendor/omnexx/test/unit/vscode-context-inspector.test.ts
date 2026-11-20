import { describe, expect, it } from 'vitest';
import {
  bindContextInspectorHud,
  hydrateContextInspector,
  renderContextInspectorHud,
} from '../../vscode/src/webview/contextInspector.js';

describe('contextInspector state hydration (9.6)', () => {
  it('hydrates chat-state-like usage/context snapshots', () => {
    const state = hydrateContextInspector({
      usage: { tokens: { input: 10_000, output: 1200, cacheRead: 8000, cacheWrite: 200 } },
      context: { used: 30_000, limit: 120_000 },
      activeTools: [{ name: 'read_file', kind: 'read', detail: 'src/a.ts' }],
    });

    expect(state.tokens.input).toBe(10_000);
    expect(state.tokens.output).toBe(1200);
    expect(state.tokens.cacheRead).toBe(8000);
    expect(state.tokens.cacheWrite).toBe(200);
    expect(state.tokens.total).toBe(11_200);
    expect(state.tokens.active).toBe(30_000);
    expect(state.tokens.limit).toBe(120_000);
    expect(state.kvCacheHitRatio).toBeCloseTo(0.8, 5);
    expect(state.kvCacheHitPercent).toBe(80);
    expect(state.activeTools).toEqual([{ name: 'read_file', kind: 'read', detail: 'src/a.ts' }]);
    expect(state.hasData).toBe(true);
  });

  it('normalizes partial, invalid, and alternate shapes safely', () => {
    const state = hydrateContextInspector({
      tokens: { input: 50, output: 10, cacheRead: -5, cacheWrite: Number.NaN },
      activeTokens: 100.9,
      contextLimit: 0, // invalid -> null
      tools: ['bash', { tool: 'edit_file', status: 'running' }, { nope: true }, 123],
      kvCacheHitRatio: 1.5, // clamped
    });

    expect(state.tokens.cacheRead).toBe(0);
    expect(state.tokens.cacheWrite).toBe(0);
    expect(state.tokens.active).toBe(101);
    expect(state.tokens.limit).toBeNull();
    expect(state.kvCacheHitRatio).toBe(1);
    expect(state.kvCacheHitPercent).toBe(100);
    expect(state.activeTools).toEqual([{ name: 'bash' }, { name: 'edit_file', detail: 'running' }]);
  });

  it('derives KV-cache hit ratio from cacheRead/input when not provided', () => {
    expect(
      hydrateContextInspector({ tokens: { input: 200, output: 0, cacheRead: 50, cacheWrite: 0 } })
        .kvCacheHitPercent,
    ).toBe(25);
    expect(hydrateContextInspector(null).kvCacheHitPercent).toBe(0);
    expect(hydrateContextInspector({}).hasData).toBe(false);
  });
});

describe('contextInspector HUD data binding (9.6)', () => {
  it('binds hydrated state into a display model', () => {
    const state = hydrateContextInspector({
      usage: { tokens: { input: 1000, output: 500, cacheRead: 900, cacheWrite: 0 } },
      context: { used: 95_000, limit: 100_000 },
      activeTools: [{ name: 'search', kind: 'find' }],
    });
    const model = bindContextInspectorHud(state);

    expect(model.activeTokensLabel).toContain('95');
    expect(model.activeTokensLabel).toContain('100');
    expect(model.kvCacheLabel).toBe('90%');
    expect(model.kvCachePercent).toBe(90);
    expect(model.activeToolsLabel).toBe('1');
    expect(model.activeTools).toEqual([{ name: 'search', kind: 'find', detail: '' }]);
    expect(model.tone).toBe('hot'); // 95%
    expect(model.hasData).toBe(true);
  });

  it('falls back to previous stable state when new state has no data', () => {
    const prev = hydrateContextInspector({
      usage: { tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } },
      activeTools: ['bash'],
    });
    const empty = hydrateContextInspector({});
    const model = bindContextInspectorHud(empty, prev);
    expect(model.hasData).toBe(true);
    expect(model.activeToolsLabel).toBe('1');
  });

  it('renders HUD HTML with token counts, KV-cache ratio, and active tools', () => {
    const html = renderContextInspectorHud(
      hydrateContextInspector({
        usage: { tokens: { input: 2048, output: 256, cacheRead: 1024, cacheWrite: 64 } },
        context: { used: 4096, limit: 8192 },
        activeTools: [
          { name: 'apply_patch', kind: 'edit', detail: 'src/x.ts' },
          { name: 'bash', kind: 'run' },
        ],
      }),
    );

    expect(html).toContain('Context HUD');
    expect(html).toContain('Active tokens');
    expect(html).toContain('KV-cache hit');
    expect(html).toContain('50%'); // 1024/2048
    expect(html).toContain('Active tools');
    expect(html).toContain('apply_patch');
    expect(html).toContain('src/x.ts');
    expect(html).toContain('bash');
    expect(html).toContain('role="meter"');
    expect(html).not.toContain('<script');
  });

  it('renders an empty/waiting HUD when there is no data', () => {
    const html = renderContextInspectorHud(hydrateContextInspector(null));
    expect(html).toContain('waiting for context');
    expect(html).toContain('data-ctx-hud');
  });
});
