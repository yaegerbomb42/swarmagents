/**
 * VirtualVM — an in-memory simulated shell + filesystem for the sandbox
 * dashboard. Client-side only: no server execution, no Node built-ins.
 *
 * The VFS is seeded with a tiny project at /home/user/project and every
 * writable command mutates it. Git status diffs against the seed.
 */

export type SandboxEventType = 'stdout' | 'stderr' | 'exit';

export interface SandboxEvent {
  type: SandboxEventType;
  text: string;
  timestamp: number;
}

export type SandboxListener = (event: SandboxEvent) => void;

export interface VfsFileStatus {
  path: string;
  status: 'created' | 'modified' | 'unchanged';
}

interface VfsEntry {
  kind: 'file' | 'dir';
  content: string;
  createdAt: number;
  modifiedAt: number;
}

export const PROJECT_ROOT = '/home/user/project';

const SEED_FILES: Record<string, string> = {
  [`${PROJECT_ROOT}/package.json`]: [
    '{',
    '  "name": "project",',
    '  "version": "1.0.0",',
    '  "scripts": { "test": "node test.js" }',
    '}',
    '',
  ].join('\n'),
  [`${PROJECT_ROOT}/test.js`]: "// Tiny example test\nconsole.log('hello from project');\n",
  [`${PROJECT_ROOT}/README.md`]: '# project\n\nA tiny example project used by the virtual sandbox.\n',
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function normalizePath(raw: string, cwd: string): string {
  const abs = raw.startsWith('/') ? raw : `${cwd}/${raw}`;
  const stack: string[] = [];
  for (const segment of abs.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.length === 0 ? '/' : `/${stack.join('/')}`;
}

function parentPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current !== '') tokens.push(current);
  return tokens;
}

const HELP_TEXT = [
  'Available commands:',
  '  ls [path]            list directory contents',
  '  cat <file>           print a file',
  '  mkdir [-p] <dir>     create a directory',
  '  touch <file>         create an empty file',
  '  echo <text> [> f]    print text or write it to a file',
  '  pwd                  print the working directory',
  '  cd <dir>             change directory',
  '  npm install           simulate an install (creates node_modules)',
  '  node test.js          run the example test',
  '  git status            show created/modified files',
  '  clear                 clear the terminal',
  '  help                  show this help',
].join('\n');

export class VirtualVM {
  private readonly files = new Map<string, VfsEntry>();
  private cwd = PROJECT_ROOT;
  private readonly listeners = new Set<SandboxListener>();

  constructor() {
    const now = Date.now();
    for (const path of ['/', '/home', '/home/user', PROJECT_ROOT]) {
      this.files.set(path, {
        kind: 'dir',
        content: '',
        createdAt: now,
        modifiedAt: now,
      });
    }
    for (const [path, content] of Object.entries(SEED_FILES)) {
      this.files.set(path, {
        kind: 'file',
        content,
        createdAt: now,
        modifiedAt: now,
      });
    }
  }

  /** Subscribe to stdout/stderr/exit events. Returns an unsubscribe fn. */
  on(listener: SandboxListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(type: SandboxEventType, text: string): void {
    const event: SandboxEvent = { type, text, timestamp: Date.now() };
    for (const listener of this.listeners) listener(event);
  }

  /**
   * Run a simulated command. Always resolves with an exit code; never
   * throws for user-facing errors.
   */
  async run(cmd: string): Promise<number> {
    const trimmed = cmd.trim();
    if (trimmed === '') {
      this.emit('exit', '0');
      return 0;
    }

    const args = tokenize(trimmed);
    const command = args[0]!;
    const rest = args.slice(1);
    let code: number;

    switch (command) {
      case 'ls':
        code = this.cmdLs(rest);
        break;
      case 'cat':
        code = this.cmdCat(rest);
        break;
      case 'mkdir':
        code = this.cmdMkdir(rest);
        break;
      case 'touch':
        code = this.cmdTouch(rest);
        break;
      case 'echo':
        code = this.cmdEcho(rest);
        break;
      case 'pwd':
        this.emit('stdout', `${this.cwd}\n`);
        code = 0;
        break;
      case 'cd':
        code = this.cmdCd(rest);
        break;
      case 'npm':
        code = this.cmdNpm(rest);
        break;
      case 'node':
        code = await this.cmdNode(rest);
        break;
      case 'git':
        code = this.cmdGit(rest);
        break;
      case 'clear':
        this.emit('stdout', '\u001b[2J\u001b[H');
        code = 0;
        break;
      case 'help':
        this.emit('stdout', `${HELP_TEXT}\n`);
        code = 0;
        break;
      default:
        this.emit('stderr', `${command}: command not found\n`);
        code = 127;
    }

    this.emit('exit', String(code));
    return code;
  }

  /**
   * Current writable/readable files and their status relative to the seed.
   */
  listFiles(): VfsFileStatus[] {
    const out: VfsFileStatus[] = [];
    for (const [path, entry] of this.files) {
      if (entry.kind !== 'file') continue;
      const seed = SEED_FILES[path];
      const status: VfsFileStatus['status'] =
        seed === undefined ? 'created' : seed === entry.content ? 'unchanged' : 'modified';
      out.push({ path, status });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  // --- commands -------------------------------------------------------

  private getDir(path: string): VfsEntry | undefined {
    return this.files.get(path)?.kind === 'dir' ? this.files.get(path) : undefined;
  }

  private cmdLs(args: string[]): number {
    const target = args[0] ? normalizePath(args[0]!, this.cwd) : this.cwd;
    if (!this.getDir(target)) {
      this.emit('stderr', `ls: cannot access '${args[0] ?? target}': No such file or directory\n`);
      return 1;
    }
    const prefix = target === '/' ? '/' : `${target}/`;
    const entries: string[] = [];
    for (const [path, entry] of this.files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest === '' || rest.includes('/')) continue;
      entries.push(entry.kind === 'dir' ? `${rest}/` : rest);
    }
    if (entries.length > 0) this.emit('stdout', `${entries.sort().join('\n')}\n`);
    return 0;
  }

  private cmdCat(args: string[]): number {
    if (args.length === 0) {
      this.emit('stderr', 'cat: missing operand\n');
      return 1;
    }
    const path = normalizePath(args[0]!, this.cwd);
    const entry = this.files.get(path);
    if (!entry || entry.kind === 'dir') {
      this.emit('stderr', `cat: ${args[0]}: No such file or directory\n`);
      return 1;
    }
    this.emit('stdout', entry.content);
    return 0;
  }

  private cmdMkdir(args: string[]): number {
    const recursive = args[0] === '-p';
    const targets = recursive ? args.slice(1) : args;
    if (targets.length === 0) {
      this.emit('stderr', 'mkdir: missing operand\n');
      return 1;
    }
    for (const raw of targets) {
      const path = normalizePath(raw, this.cwd);
      const existing = this.files.get(path);
      if (existing?.kind === 'dir') continue;
      if (existing) {
        this.emit('stderr', `mkdir: cannot create directory '${raw}': File exists\n`);
        return 1;
      }
      if (!recursive && !this.getDir(parentPath(path))) {
        this.emit('stderr', `mkdir: cannot create directory '${raw}': No such file or directory\n`);
        return 1;
      }
      const stack = path.split('/').filter(Boolean);
      let acc = '';
      for (const segment of stack) {
        acc += `/${segment}`;
        if (!this.files.has(acc)) {
          const now = Date.now();
          this.files.set(acc, { kind: 'dir', content: '', createdAt: now, modifiedAt: now });
        }
      }
    }
    return 0;
  }

  private cmdTouch(args: string[]): number {
    if (args.length === 0) {
      this.emit('stderr', 'touch: missing file operand\n');
      return 1;
    }
    for (const raw of args) {
      const path = normalizePath(raw, this.cwd);
      if (!this.getDir(parentPath(path))) {
        this.emit('stderr', `touch: cannot touch '${raw}': No such file or directory\n`);
        return 1;
      }
      const existing = this.files.get(path);
      if (existing?.kind === 'dir') {
        this.emit('stderr', `touch: cannot touch '${raw}': Is a directory\n`);
        return 1;
      }
      const now = Date.now();
      if (existing) existing.modifiedAt = now;
      else this.files.set(path, { kind: 'file', content: '', createdAt: now, modifiedAt: now });
    }
    return 0;
  }

  private cmdEcho(args: string[]): number {
    const redirect = args.indexOf('>');
    if (redirect === -1) {
      this.emit('stdout', `${args.join(' ')}\n`);
      return 0;
    }
    if (redirect === args.length - 1) {
      this.emit('stderr', 'echo: missing redirect target\n');
      return 1;
    }
    const text = args.slice(0, redirect).join(' ');
    const rawTarget = args[redirect + 1]!;
    const path = normalizePath(rawTarget, this.cwd);
    if (!this.getDir(parentPath(path))) {
      this.emit('stderr', `echo: cannot create '${rawTarget}': No such file or directory\n`);
      return 1;
    }
    const existing = this.files.get(path);
    if (existing?.kind === 'dir') {
      this.emit('stderr', `echo: cannot redirect to '${rawTarget}': Is a directory\n`);
      return 1;
    }
    const now = Date.now();
    this.files.set(path, {
      kind: 'file',
      content: `${text}\n`,
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now,
    });
    return 0;
  }

  private cmdCd(args: string[]): number {
    if (args.length === 0) {
      this.cwd = PROJECT_ROOT;
      return 0;
    }
    const target = normalizePath(args[0]!, this.cwd);
    if (!this.getDir(target)) {
      this.emit('stderr', `cd: no such file or directory: ${args[0]}\n`);
      return 1;
    }
    this.cwd = target;
    return 0;
  }

  private cmdNpm(args: string[]): number {
    void args;
    const now = Date.now();
    const modules = `${this.cwd}/node_modules`;
    if (!this.files.has(modules)) {
      this.files.set(modules, { kind: 'dir', content: '', createdAt: now, modifiedAt: now });
    }
    // Marker file so git status / listFiles show the install happened.
    const marker = `${modules}/.package-lock.json`;
    if (!this.files.has(marker)) {
      this.files.set(marker, {
        kind: 'file',
        content: '{"name":"node_modules"}\n',
        createdAt: now,
        modifiedAt: now,
      });
    }
    this.emit('stdout', 'npm notice creating a lockfile as package-lock.json\n');
    this.emit('stdout', 'npm notice added 437 packages, and audited 438 packages in 1.2s\n');
    this.emit('stdout', 'found 0 vulnerabilities\n');
    return 0;
  }

  private async cmdNode(args: string[]): Promise<number> {
    if (args[0] !== 'test.js') {
      this.emit('stderr', `node: cannot find module '${args[0] ?? ''}'\n`);
      return 1;
    }
    this.emit('stdout', '> project@1.0.0 test\n');
    this.emit('stdout', '> node test.js\n\n');
    await sleep(15);
    this.emit('stdout', '✓ example test passes\n');
    await sleep(15);
    this.emit('stdout', '1 test passed, 0 failed\n');
    return 0;
  }

  private cmdGit(args: string[]): number {
    if (args[0] !== 'status') {
      this.emit('stderr', `git: '${args[0] ?? ''}' is not a supported subcommand\n`);
      return 1;
    }
    this.emit('stdout', 'On branch main\n');
    const files = this.listFiles();
    const modified = files.filter((f) => f.status === 'modified');
    const created = files.filter((f) => f.status === 'created');
    if (modified.length === 0 && created.length === 0) {
      this.emit('stdout', 'nothing to commit, working tree clean\n');
      return 0;
    }
    if (modified.length > 0) {
      this.emit('stdout', '\nChanges not staged for commit:\n  (use "git add <file>..." to update what will be committed)\n');
      for (const f of modified) this.emit('stdout', `  modified:   ${f.path.slice(PROJECT_ROOT.length + 1)}\n`);
    }
    if (created.length > 0) {
      this.emit('stdout', '\nUntracked files:\n');
      for (const f of created) this.emit('stdout', `  ${f.path.slice(PROJECT_ROOT.length + 1)}\n`);
    }
    return 0;
  }
}
