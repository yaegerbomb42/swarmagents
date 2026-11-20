import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const IMPORT_EXPORT_REGEX =
  /(?:import|export)\s+(?:(?:[\w*\s{},]*)\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function stripExtension(p: string): string {
  return p.replace(/\.[cm]?[jt]sx?$/, '');
}

/**
 * Extracts import/require specifiers from source file content.
 */
export function extractImportSpecifiers(sourceText: string): string[] {
  const specifiers: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = IMPORT_EXPORT_REGEX.exec(sourceText)) !== null) {
    const spec = match[1] ?? match[2];
    if (spec && (spec.startsWith('.') || spec.startsWith('/'))) {
      specifiers.push(spec);
    }
  }
  return specifiers;
}

/**
 * Determines whether `importerFile` directly imports `targetFile`.
 */
export function doesFileImportTarget(
  importerFile: string,
  importerText: string,
  targetFile: string,
): boolean {
  const targetBase = stripExtension(resolve(targetFile));
  const importerDir = dirname(resolve(importerFile));
  const specs = extractImportSpecifiers(importerText);

  for (const spec of specs) {
    const resolvedSpec = stripExtension(resolve(importerDir, spec));
    if (resolvedSpec === targetBase) {
      return true;
    }
  }
  return false;
}

/**
 * Scans candidate project files to find those that directly import `targetFile`.
 * Returns up to maxImporters results to maintain low latency.
 */
export async function findReverseImporters(
  targetFile: string,
  candidateFiles: readonly string[],
  maxImporters = 5,
): Promise<string[]> {
  const resolvedTarget = resolve(targetFile);
  const importers: string[] = [];

  for (const file of candidateFiles) {
    if (resolve(file) === resolvedTarget) continue;
    try {
      const text = await readFile(file, 'utf8');
      if (doesFileImportTarget(file, text, resolvedTarget)) {
        importers.push(file);
        if (importers.length >= maxImporters) break;
      }
    } catch {
      // Ignore unreadable files
    }
  }

  return importers;
}
