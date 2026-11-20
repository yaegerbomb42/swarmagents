import { describe, expect, it } from 'vitest';
import { extractPillCmd } from '../../vscode/src/webview/render.js';
import { TerminalPillManager } from '../../vscode/src/terminal-pill.js';

describe('extractPillCmd', () => {
  it('pulls the backticked command out of a bash narration', () => {
    expect(extractPillCmd('running `npm test`')).toEqual({ cmd: 'npm test', isCommand: true });
  });

  it('falls back to the narration text when there is no command', () => {
    expect(extractPillCmd('running test suite')).toEqual({
      cmd: 'running test suite',
      isCommand: false,
    });
  });

  it('takes the first backticked span', () => {
    expect(extractPillCmd('running `git status` now')).toEqual({
      cmd: 'git status',
      isCommand: true,
    });
  });
});

describe('TerminalPillManager', () => {
  function collect(): {
    posted: Record<string, unknown>[];
    manager: TerminalPillManager;
  } {
    const posted: Record<string, unknown>[] = [];
    const manager = new TerminalPillManager((msg) => {
      posted.push(msg as Record<string, unknown>);
    });
    return { posted, manager };
  }

  it('starts a pill on a run act line, echoes the command, ends it on the next tool line', () => {
    const { posted, manager } = collect();
    manager.observeState({
      entries: [{ id: 1, kind: 'act', text: 'running `npm test`' }],
      busy: true,
    });
    manager.observeState({
      entries: [{ id: 2, kind: 'act', text: 'reading src/a.ts' }],
      busy: true,
    });
    expect(posted.map((p) => p.type)).toEqual(['pillStart', 'pillOutput', 'pillEnd']);
    expect(posted[0]).toMatchObject({ type: 'pillStart', id: 1, cmd: 'npm test' });
    expect(posted[1]).toMatchObject({ type: 'pillOutput', id: 1, chunk: '$ npm test\n' });
    expect(posted[2]).toMatchObject({ type: 'pillEnd', id: 1, status: 'success' });
    expect(typeof posted[2]?.elapsedMs).toBe('number');
  });

  it('marks the pill failed and appends the error line when an err line follows', () => {
    const { posted, manager } = collect();
    manager.observeState({
      entries: [{ id: 1, kind: 'act', text: 'running `npm test`' }],
      busy: true,
    });
    manager.observeState({
      entries: [{ id: 2, kind: 'err', text: '  ✗ exit code 1' }],
      busy: true,
    });
    expect(posted.map((p) => p.type)).toEqual(['pillStart', 'pillOutput', 'pillOutput', 'pillEnd']);
    expect(posted[2]).toMatchObject({ type: 'pillOutput', id: 1, chunk: '  ✗ exit code 1\n' });
    expect(posted[3]).toMatchObject({ type: 'pillEnd', id: 1, status: 'error' });
  });

  it('ends the open pill when the turn goes idle', () => {
    const { posted, manager } = collect();
    manager.observeState({
      entries: [{ id: 1, kind: 'act', text: 'running `npm test`' }],
      busy: true,
    });
    manager.observeState({ entries: [], busy: false });
    expect(posted.map((p) => p.type)).toEqual(['pillStart', 'pillOutput', 'pillEnd']);
    expect(posted[2]).toMatchObject({ type: 'pillEnd', id: 1, status: 'success' });
  });

  it('ignores non-tool entries and err lines with no pill open', () => {
    const { posted, manager } = collect();
    manager.observeState({
      entries: [
        { id: 1, kind: 'out', text: 'Done.' },
        { id: 2, kind: 'err', text: '  ✗ stray' },
      ],
      busy: true,
    });
    expect(posted).toEqual([]);
  });

  it('ignores a duplicate start for the pill already open', () => {
    const { posted, manager } = collect();
    const frame = {
      entries: [{ id: 1, kind: 'act', text: 'running `npm test`' }],
      busy: true,
    };
    manager.observeState(frame);
    manager.observeState(frame);
    expect(posted.map((p) => p.type)).toEqual(['pillStart', 'pillOutput']);
  });

  it('reset drops the open pill without posting an end', () => {
    const { posted, manager } = collect();
    manager.observeState({
      entries: [{ id: 1, kind: 'act', text: 'running `npm test`' }],
      busy: true,
    });
    manager.reset();
    manager.observeState({
      entries: [{ id: 2, kind: 'act', text: 'reading src/a.ts' }],
      busy: true,
    });
    expect(posted.map((p) => p.type)).toEqual(['pillStart', 'pillOutput']);
  });
});
