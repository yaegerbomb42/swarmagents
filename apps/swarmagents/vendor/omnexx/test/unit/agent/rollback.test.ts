import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitTreeSnapshotter } from '../../../src/agent/runtime/checkpoint.js';
import { SpeculativeBranchRollbackManager } from '../../../src/agent/runtime/rollback.js';
import type { Message } from '../../../src/providers/types.js';
import { tempRepo } from '../../support/tmp.js';
import { git } from '../../../src/git/git.js';

describe('Step 3.7: Speculative Branch Rollback Manager (rollback.ts)', () => {
  it('arms checkpoint, restores workspace files, truncates messages, and injects intervention on failure', async () => {
    const root = await tempRepo();
    await writeFile(join(root, 'app.ts'), 'export const baseline = 1;\n');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'init']);

    const snapshotter = new GitTreeSnapshotter(root);
    const rollbackMgr = new SpeculativeBranchRollbackManager(snapshotter, {
      maxRollbacksPerRun: 2,
    });

    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Task start' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Plan' }] },
    ];

    // Arm checkpoint before risky mutation
    await rollbackMgr.armCheckpoint(1, messages);
    expect(rollbackMgr.hasActiveCheckpoint).toBe(true);

    // Simulate speculative bad edits & new rogue file
    await writeFile(join(root, 'app.ts'), 'export const broken = 999;\n');
    await writeFile(join(root, 'rogue.ts'), 'const bad = true;\n');
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'bash_1', name: 'bash', input: { command: 'bad' } }],
    });
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'bash_1', content: 'Syntax error TS1005' }],
    });

    expect(messages.length).toBe(4);

    // Execute rollback
    const result = await rollbackMgr.executeRollback(messages, 'Fatal syntax error in app.ts');

    expect(result.rolledBack).toBe(true);
    // Messages truncated to 2 + 1 intervention = 3
    expect(messages.length).toBe(3);
    const lastMsg = messages[messages.length - 1]?.content[0];
    expect(lastMsg && 'text' in lastMsg ? lastMsg.text : '').toContain(
      '<system_intervention type="branch_rollback">',
    );

    // Verify workspace restored
    const restoredContent = await (
      await import('node:fs/promises')
    ).readFile(join(root, 'app.ts'), 'utf8');
    expect(restoredContent).toBe('export const baseline = 1;\n');

    // Verify untracked rogue file was cleaned up
    const rogueExists = await (
      await import('node:fs/promises')
    )
      .stat(join(root, 'rogue.ts'))
      .then(() => true)
      .catch(() => false);
    expect(rogueExists).toBe(false);
  });

  it('bounds rollbacks per run and refuses execution when ceiling is exceeded', async () => {
    const root = await tempRepo();
    await writeFile(join(root, 'a.txt'), 'x\n');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'init']);

    const snapshotter = new GitTreeSnapshotter(root);
    const rollbackMgr = new SpeculativeBranchRollbackManager(snapshotter, {
      maxRollbacksPerRun: 1,
    });

    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Initial message' }] },
    ];

    // Rollback 1: Allowed
    await rollbackMgr.armCheckpoint(1, messages);
    const res1 = await rollbackMgr.executeRollback(messages, 'Error 1');
    expect(res1.rolledBack).toBe(true);
    expect(rollbackMgr.remainingRollbacks).toBe(0);

    // Rollback 2: Denied (maxRollbacks reached)
    await rollbackMgr.armCheckpoint(2, messages);
    const res2 = await rollbackMgr.executeRollback(messages, 'Error 2');
    expect(res2.rolledBack).toBe(false);
    expect(res2.reason).toContain('Max rollbacks (1) exceeded');
  });
});
