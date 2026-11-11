import { afterEach, describe, expect, it } from 'vitest';
import {
  AutonomousStateStore,
  cooldownUntilForStrike,
  globMatches,
  MAX_STRIKES_BEFORE_PERMANENT,
  TOMBSTONE_COOLDOWNS_MS,
  uuidv7,
} from './state-store.js';

let store: AutonomousStateStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

describe('globMatches', () => {
  it('matches stars, double stars and question marks', () => {
    expect(globMatches('src/*.ts', 'src/a.ts')).toBe(true);
    expect(globMatches('src/*.ts', 'src/deep/a.ts')).toBe(false);
    expect(globMatches('src/**/a.ts', 'src/a.ts')).toBe(true);
    expect(globMatches('src/**/a.ts', 'src/deep/nested/a.ts')).toBe(true);
    expect(globMatches('a?.ts', 'ab.ts')).toBe(true);
    expect(globMatches('a?.ts', 'abc.ts')).toBe(false);
  });
});

describe('cooldownUntilForStrike', () => {
  it('walks the strike ladder and becomes permanent', () => {
    const now = 1_000_000;
    expect(cooldownUntilForStrike(1, now) - now).toBe(TOMBSTONE_COOLDOWNS_MS[0]);
    expect(cooldownUntilForStrike(2, now) - now).toBe(TOMBSTONE_COOLDOWNS_MS[1]);
    expect(cooldownUntilForStrike(MAX_STRIKES_BEFORE_PERMANENT, now)).toBe(-1);
  });
});

describe('uuidv7', () => {
  it('sets version and variant bits', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('AutonomousStateStore journal', () => {
  it('opens once for concurrent callers', async () => {
    store = new AutonomousStateStore({ repoRoot: '/tmp', dbPath: ':memory:' });
    await Promise.all([store.open(), store.open()]);
    expect(store.isOpen).toBe(true);
  });

  it('returns the newest step without loading the whole journal', async () => {
    store = new AutonomousStateStore({ repoRoot: '/tmp', dbPath: ':memory:' });
    await store.open();
    const task = store.enqueueTask({
      fingerprint: 'fp-1',
      sourceCollector: 'test',
      priorityScore: 1,
      targetFiles: ['src/a.ts'],
      findingPayload: { title: 'a' },
    });
    store.recordStep(task.taskId, { phase: 'plan' });
    store.recordStep(task.taskId, { phase: 'implement', toolName: 'read' });
    expect(store.getSteps(task.taskId)).toHaveLength(2);
    const latest = store.getLatestStep(task.taskId);
    expect(latest?.stepIndex).toBe(1);
    expect(latest?.phase).toBe('implement');
  });

  it('prunes journal rows for tasks that left the queue', async () => {
    store = new AutonomousStateStore({ repoRoot: '/tmp', dbPath: ':memory:' });
    await store.open();
    const kept = store.enqueueTask({
      fingerprint: 'fp-kept',
      sourceCollector: 'test',
      priorityScore: 1,
      targetFiles: [],
      findingPayload: {},
    });
    const dropped = store.enqueueTask({
      fingerprint: 'fp-dropped',
      sourceCollector: 'test',
      priorityScore: 2,
      targetFiles: [],
      findingPayload: {},
    });
    store.recordStep(kept.taskId, { phase: 'plan' });
    store.recordStep(dropped.taskId, { phase: 'plan' });
    store.recordStep(dropped.taskId, { phase: 'verify' });

    expect(store.deleteTask(dropped.taskId)).toBe(true);
    expect(store.pruneOrphanedSteps()).toBe(2);
    expect(store.getSteps(kept.taskId)).toHaveLength(1);
    expect(store.getSteps(dropped.taskId)).toHaveLength(0);
  });

  it('marks done tasks and removes them from the queue atomically', async () => {
    store = new AutonomousStateStore({ repoRoot: '/tmp', dbPath: ':memory:' });
    await store.open();
    const task = store.enqueueTask({
      fingerprint: 'fp-done',
      sourceCollector: 'test',
      priorityScore: 1,
      targetFiles: ['src/a.ts'],
      findingPayload: {},
    });
    const done = store.markDone(task.taskId, {
      deliveryMode: 'commit',
      targetBlobHashes: { 'src/a.ts': 'abc' },
    });
    expect(done?.fingerprint).toBe('fp-done');
    expect(store.isDone('fp-done')).toBe(true);
    expect(store.getTask(task.taskId)).toBeNull();
  });
});
