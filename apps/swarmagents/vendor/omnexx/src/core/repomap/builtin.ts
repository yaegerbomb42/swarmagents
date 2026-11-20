/**
 * Dependency-free fallback extractor.
 *
 * Line-based and regex-driven; it exists so Omnexx installs and CI keep working when the
 * optional `web-tree-sitter` WASM backend is not available. It captures the same tag shapes
 * (definitions with collapsed signatures, references with lines) at lower fidelity: no parse
 * tree, so multi-line signatures are stitched heuristically and references are a token scan
 * with a keyword filter. Rankings from this engine are marked `builtin` and are deterministic
 * like everything else.
 */
import { extractImports } from '../ast-cache.js';
import { findBraceEndLine, findPythonEndLine } from '../../tools/outline.js';
import { languageForPath } from './queries.js';
import { collapseReference, collapseSignature } from './signature.js';
import type { DefKind, FileExtraction, RepoTag } from './types.js';

interface DefRule {
  readonly re: RegExp;
  readonly kind: DefKind;
}

const TS_RULES: readonly DefRule[] = [
  {
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
    kind: 'function',
  },
  {
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    kind: 'class',
  },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/, kind: 'type' },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
  {
    re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>)/,
    kind: 'function',
  },
  {
    re: /^\s*export\s+(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^=]/,
    kind: 'const',
  },
  {
    re: /^\s{2,}(?:(?:public|private|protected|static|async|readonly|override|abstract)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{=]+)?\{/,
    kind: 'method',
  },
];

const JS_RULES: readonly DefRule[] = [
  {
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
    kind: 'function',
  },
  { re: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  {
    re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>)/,
    kind: 'function',
  },
  { re: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^=]/, kind: 'const' },
  {
    re: /^\s{2,}(?:(?:static|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/,
    kind: 'method',
  },
];

const GO_RULES: readonly DefRule[] = [
  { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'function' },
  { re: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, kind: 'type' },
];

const KEYWORDS = new Set(
  (
    'if else for while switch case default break continue return throw try catch finally new delete typeof instanceof in of do ' +
    'const let var function class interface type enum implements extends import export from as default async await static get set ' +
    'public private protected readonly abstract override super this self print len range map filter reduce zip ' +
    'func go defer chan select range package nil true false iota map make append copy delete close cap new ' +
    'not and or is as lambda pass with yield global nonlocal assert raise del elif except finally global import from as ' +
    'None True False self cls print lambda def class'
  ).split(/\s+/),
);

const TOKEN_RE = /[A-Za-z_$][\w$]*/g;

/** Extract with zero dependencies. Always available; the fallback of last resort. */
export class BuiltinExtractor {
  readonly id = 'builtin' as const;

  extract(path: string, text: string): FileExtraction {
    const language = languageForPath(path) ?? 'unknown';
    const lines = text.split('\n');
    const tags: RepoTag[] = [];
    const seen = new Set<string>();
    const push = (tag: RepoTag): void => {
      const key = `${tag.kind}:${tag.defKind ?? ''}:${tag.name}:${tag.line}`;
      if (seen.has(key)) return;
      seen.add(key);
      tags.push(tag);
    };

    // --- definitions ---
    if (language === 'python') {
      extractPythonDefs(lines, path, push);
    } else if (language === 'go') {
      extractWithRules(lines, path, GO_RULES, push, true);
    } else {
      extractWithRules(lines, path, language === 'javascript' ? JS_RULES : TS_RULES, push, true);
    }

    // --- references (token scan with a keyword filter) ---
    const refCounts = new Map<string, number>();
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripLineComment(lines[i] ?? '', language);
      TOKEN_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = TOKEN_RE.exec(code)) !== null) {
        const name = m[0];
        if (name.length < 3 || KEYWORDS.has(name)) continue;
        const count = refCounts.get(name) ?? 0;
        if (count >= 32) continue; // cap per name per file
        refCounts.set(name, count + 1);
        push({
          path,
          name,
          kind: 'reference',
          line: i + 1,
          endLine: i + 1,
          text: collapseReference(lines[i] ?? ''),
        });
      }
    }

    tags.sort(
      (a, b) => a.line - b.line || (a.kind === b.kind ? 0 : a.kind === 'definition' ? -1 : 1),
    );
    return { path, language, engine: 'builtin', tags, imports: extractImports(text) };
  }
}

function stripLineComment(line: string, language: string): string {
  const idx = language === 'python' ? line.indexOf('#') : line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

function extractWithRules(
  lines: readonly string[],
  path: string,
  rules: readonly DefRule[],
  push: (tag: RepoTag) => void,
  braceEnd: boolean,
): void {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    for (const rule of rules) {
      const m = rule.re.exec(line);
      const name = m?.[1];
      if (!name) continue;
      const start = i + 1;
      let endLine = start;
      if (braceEnd) {
        const calculated = findBraceEndLine(lines, start);
        if (calculated > start) endLine = calculated;
      }
      push({
        path,
        name,
        kind: 'definition',
        defKind: rule.kind,
        line: start,
        endLine,
        text: collapseSignature(lines, start, 200),
      });
      break;
    }
  }
}

function extractPythonDefs(
  lines: readonly string[],
  path: string,
  push: (tag: RepoTag) => void,
): void {
  const defRe = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/;
  const classRe = /^\s*class\s+([A-Za-z_]\w*)/;
  const constRe = /^([A-Za-z_][A-Za-z0-9_]*)\s*=[^=]/;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const start = i + 1;
    const def = defRe.exec(line);
    const cls = classRe.exec(line);
    if (def?.[1]) {
      const end = findPythonEndLine(lines, start);
      push({
        path,
        name: def[1],
        kind: 'definition',
        defKind: 'function',
        line: start,
        endLine: end,
        text: collapseSignature(lines, start, 200),
      });
      continue;
    }
    if (cls?.[1]) {
      const end = findPythonEndLine(lines, start);
      push({
        path,
        name: cls[1],
        kind: 'definition',
        defKind: 'class',
        line: start,
        endLine: end,
        text: collapseSignature(lines, start, 200),
      });
      continue;
    }
    const con = constRe.exec(line);
    if (con?.[1] && /^[A-Z][A-Z0-9_]*$/.test(con[1])) {
      push({
        path,
        name: con[1],
        kind: 'definition',
        defKind: 'const',
        line: start,
        endLine: start,
        text: collapseReference(line),
      });
    }
  }
}
