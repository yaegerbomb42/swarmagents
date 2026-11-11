import { askTsWorker, disposeTsWorkers, hasRepoTypescript, LS_PRELUDE } from './ts-worker.js';

/** One diagnostic on the edited file or an affected reverse-importer. */
export interface Diag {
  file?: string;
  line: number;
  code: string;
  message: string;
}

export interface DiagPair {
  before: Diag[];
  after: Diag[];
}

/** The worker answers "diagnostics for this file and affected reverse-importers before and after the edit". */
const WORKER_SOURCE = `${LS_PRELUDE}
const path = require('node:path');

function getDiagnosticsForFile(f, targetFile) {
  const isTarget = f === targetFile;
  const raw = isTarget
    ? [...ls.getSyntacticDiagnostics(f), ...ls.getSemanticDiagnostics(f)]
    : ls.getSemanticDiagnostics(f);

  const relFile = path.relative(root, f);
  return raw.map((d) => ({
    ...(isTarget ? {} : { file: relFile }),
    line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0,
    code: 'TS' + d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
  }));
}

function findReverseImporters(targetFile) {
  const targetBase = targetFile.replace(/\\.[cm]?[jt]sx?$/, '');
  const importers = [];
  const allFiles = host.getScriptFileNames();
  for (const f of allFiles) {
    if (f === targetFile) continue;
    const snap = host.getScriptSnapshot(f);
    if (!snap) continue;
    const text = snap.getText(0, snap.getLength());
    const pre = ts.preProcessFile(text);
    const dir = path.dirname(f);
    for (const imp of pre.importedFiles) {
      const resolved = path.resolve(dir, imp.fileName).replace(/\\.[cm]?[jt]sx?$/, '');
      if (resolved === targetBase) {
        importers.push(f);
        break;
      }
    }
    if (importers.length >= 5) break;
  }
  return importers;
}

function diags(file, text) {
  overrides.set(file, text);
  versions.set(file, (versions.get(file) || 0) + 1);

  const targetDiags = getDiagnosticsForFile(file, file);
  const importers = findReverseImporters(file);
  const importerDiags = importers.flatMap((imp) => getDiagnosticsForFile(imp, file));

  return [...targetDiags, ...importerDiags];
}
parentPort.on('message', ({ id, file, before, after }) => {
  reply(id, () => {
    try {
      return { before: diags(file, before), after: diags(file, after) };
    } finally {
      overrides.delete(file);
      versions.set(file, (versions.get(file) || 0) + 1);
    }
  });
});
`;

export const TS_EXTENSIONS = /\.(?:[cm]?tsx?|[cm]?jsx?)$/;

/** True when the repo has its own TypeScript and a tsconfig at the root. */
export const canCheck = hasRepoTypescript;

/**
 * Diagnostics for `file` before and after an edit, or null when the repo has no TypeScript, the
 * checker failed, or it took longer than `timeoutMs` (the checker keeps warming in the background,
 * so the next edit is usually fast).
 */
export async function checkTs(
  root: string,
  file: string,
  before: string,
  after: string,
  timeoutMs: number,
): Promise<DiagPair | null> {
  const r = await askTsWorker<DiagPair>(
    'check',
    WORKER_SOURCE,
    root,
    { file, before, after },
    timeoutMs,
  );
  return r;
}

/** Stop every warm checker (tests, shutdown). */
export const disposeCheckers = disposeTsWorkers;
