import { beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_ROOT, VirtualVM } from './virtualVm';
import type { SandboxEvent } from './virtualVm';

const stdout = (events: SandboxEvent[]) =>
  events.filter((e) => e.type === 'stdout').map((e) => e.text).join('');

const stderr = (events: SandboxEvent[]) =>
  events.filter((e) => e.type === 'stderr').map((e) => e.text).join('');

describe('VirtualVM', () => {
  let vm: VirtualVM;
  let events: SandboxEvent[];

  beforeEach(() => {
    vm = new VirtualVM();
    events = [];
    vm.on((event) => events.push(event));
  });

  it('is seeded with the project skeleton and files are unchanged', () => {
    expect(vm.listFiles().map((f) => f.path)).toEqual([
      `${PROJECT_ROOT}/README.md`,
      `${PROJECT_ROOT}/package.json`,
      `${PROJECT_ROOT}/test.js`,
    ]);
    expect(vm.listFiles().every((f) => f.status === 'unchanged')).toBe(true);
  });

  it('prints the working directory and lists seeded files', async () => {
    expect(await vm.run('pwd')).toBe(0);
    expect(stdout(events)).toContain(PROJECT_ROOT);

    events.length = 0;
    expect(await vm.run('ls')).toBe(0);
    const listing = stdout(events);
    expect(listing).toContain('package.json');
    expect(listing).toContain('README.md');
    expect(listing).toContain('test.js');
  });

  it('exits with 127 and "command not found" for unknown commands', async () => {
    expect(await vm.run('definitely-not-a-command')).toBe(127);
    expect(stderr(events)).toContain('command not found');
    expect(events.some((e) => e.type === 'exit' && e.text === '127')).toBe(true);
  });

  it('cat prints seeded file contents', async () => {
    expect(await vm.run('cat README.md')).toBe(0);
    expect(stdout(events)).toContain('# project');
  });

  it('error: prints to stderr and exits 1', async () => {
    expect(await vm.run('cat nope.txt')).toBe(1);
    expect(stderr(events)).toContain('No such file or directory');
  });

  it('writes files via echo redirect and tracks them as created', async () => {
    expect(await vm.run('echo hello world > notes.txt')).toBe(0);
    expect(await vm.run('cat notes.txt')).toBe(0);
    expect(stdout(events)).toContain('hello world');

    const note = vm.listFiles().find((f) => f.path === `${PROJECT_ROOT}/notes.txt`);
    expect(note?.status).toBe('created');
  });

  it('touch creates an empty file', async () => {
    expect(await vm.run('touch empty.txt')).toBe(0);
    expect(await vm.run('cat empty.txt')).toBe(0);
    expect(stdout(events)).toBe('');
    expect(vm.listFiles().some((f) => f.path === `${PROJECT_ROOT}/empty.txt`)).toBe(true);
  });

  it('mkdir -p creates nested directories and cd navigates', async () => {
    expect(await vm.run('mkdir -p src/lib')).toBe(0);
    expect(await vm.run('ls src')).toBe(0);
    expect(stdout(events)).toContain('lib/');

    expect(await vm.run('cd src/lib')).toBe(0);
    expect(await vm.run('pwd')).toBe(0);
    expect(stdout(events)).toContain(`${PROJECT_ROOT}/src/lib`);

    expect(await vm.run('cd ../..')).toBe(0);
    expect(await vm.run('pwd')).toBe(0);
    expect(stdout(events)).toContain(PROJECT_ROOT);
  });

  it('rejects cd into a missing directory', async () => {
    expect(await vm.run('cd does-not-exist')).toBe(1);
    expect(stderr(events)).toContain('no such file or directory');
  });

  it('npm install prints progress and creates the node_modules marker', async () => {
    expect(await vm.run('npm install')).toBe(0);
    const out = stdout(events);
    expect(out).toContain('added 437 packages');
    expect(out).toContain('found 0 vulnerabilities');

    const marker = vm.listFiles().find((f) => f.path === `${PROJECT_ROOT}/node_modules/.package-lock.json`);
    expect(marker?.status).toBe('created');
  });

  it('node test.js prints simulated output and exits 0', async () => {
    expect(await vm.run('node test.js')).toBe(0);
    const out = stdout(events);
    expect(out).toContain('✓ example test passes');
    expect(out).toContain('1 test passed, 0 failed');
    expect(events.some((e) => e.type === 'exit' && e.text === '0')).toBe(true);
  });

  it('git status lists created and modified files vs the seed', async () => {
    expect(await vm.run('echo changed > README.md')).toBe(0);
    expect(await vm.run('echo new > added.txt')).toBe(0);
    expect(await vm.run('git status')).toBe(0);

    const out = stdout(events);
    expect(out).toContain('On branch main');
    expect(out).toContain('modified:   README.md');
    expect(out).toContain('added.txt');

    const files = vm.listFiles();
    expect(files.find((f) => f.path.endsWith('/README.md'))?.status).toBe('modified');
    expect(files.find((f) => f.path.endsWith('/added.txt'))?.status).toBe('created');
    expect(files.find((f) => f.path.endsWith('/package.json'))?.status).toBe('unchanged');
  });

  it('git status reports a clean tree after only reads', async () => {
    await vm.run('ls');
    expect(await vm.run('git status')).toBe(0);
    expect(stdout(events)).toContain('nothing to commit, working tree clean');
  });

  it('clear and help return 0', async () => {
    expect(await vm.run('clear')).toBe(0);
    expect(await vm.run('help')).toBe(0);
    expect(stdout(events)).toContain('Available commands');
  });

  it('emits exit events with the correct code after every command', async () => {
    await vm.run('pwd');
    await vm.run('nope');
    const exits = events.filter((e) => e.type === 'exit');
    expect(exits.map((e) => e.text)).toEqual(['0', '127']);
  });
});
