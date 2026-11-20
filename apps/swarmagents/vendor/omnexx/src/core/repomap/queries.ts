/**
 * Embedded tree-sitter tag queries and language detection.
 *
 * The query shape (`@name.definition.<kind>` / `@name.reference.<kind>` plus the enclosing
 * `@definition.<kind>` / `@reference.<kind>` capture) is adapted from Aider's tag queries
 * (https://github.com/Aider-AI/aider — Apache-2.0), trimmed to the three reference kinds we
 * rank on (calls, constructors, type references) and extended with module-level exported
 * constants. Aider ships separate query files per grammar because node names differ between
 * grammars; we do the same here — do not merge them.
 *
 * Embedded as strings (not .scm files) so the ESM build and `tsup` need no asset copying.
 */

export type LanguageId = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go';

export const LANGUAGE_IDS: readonly LanguageId[] = [
  'typescript',
  'tsx',
  'javascript',
  'python',
  'go',
];

const EXTENSION_LANGUAGES: Readonly<Record<string, LanguageId>> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
};

/** Resolve a language id from a repo-relative path, or null when unsupported. */
export function languageForPath(path: string): LanguageId | null {
  const norm = path.replace(/\\/g, '/');
  const dot = norm.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = norm.slice(dot).toLowerCase();
  return EXTENSION_LANGUAGES[ext] ?? null;
}

/** File extensions the extractor looks at, for repository walks. */
export function sourceExtensions(): string[] {
  return Object.keys(EXTENSION_LANGUAGES);
}

const TYPESCRIPT_QUERY = `
(function_declaration name: (identifier) @name.definition.function) @definition.function
(generator_function_declaration name: (identifier) @name.definition.function) @definition.function
(class_declaration name: (type_identifier) @name.definition.class) @definition.class
(abstract_class_declaration name: (type_identifier) @name.definition.class) @definition.class
(interface_declaration name: (type_identifier) @name.definition.interface) @definition.interface
(type_alias_declaration name: (type_identifier) @name.definition.type) @definition.type
(enum_declaration name: (identifier) @name.definition.enum) @definition.enum
(method_definition name: (property_identifier) @name.definition.method) @definition.method
(method_signature name: (property_identifier) @name.definition.method) @definition.method
(abstract_method_signature name: (property_identifier) @name.definition.method) @definition.method
(lexical_declaration (variable_declarator name: (identifier) @name.definition.function value: [(arrow_function) (function_expression)])) @definition.function
(lexical_declaration (variable_declarator name: (identifier) @name.definition.const)) @definition.const
(variable_declaration (variable_declarator name: (identifier) @name.definition.const)) @definition.const
(call_expression function: [(identifier) @name.reference.call (member_expression property: (property_identifier) @name.reference.call)]) @reference.call
(new_expression constructor: [(identifier) @name.reference.class (member_expression property: (property_identifier) @name.reference.class)]) @reference.class
(type_annotation (type_identifier) @name.reference.type) @reference.type
`;

const TSX_QUERY = TYPESCRIPT_QUERY;

const JAVASCRIPT_QUERY = `
(function_declaration name: (identifier) @name.definition.function) @definition.function
(generator_function_declaration name: (identifier) @name.definition.function) @definition.function
(class_declaration name: (identifier) @name.definition.class) @definition.class
(method_definition name: (property_identifier) @name.definition.method) @definition.method
(lexical_declaration (variable_declarator name: (identifier) @name.definition.function value: [(arrow_function) (function_expression)])) @definition.function
(lexical_declaration (variable_declarator name: (identifier) @name.definition.const)) @definition.const
(variable_declaration (variable_declarator name: (identifier) @name.definition.const)) @definition.const
(call_expression function: [(identifier) @name.reference.call (member_expression property: (property_identifier) @name.reference.call)]) @reference.call
(new_expression constructor: [(identifier) @name.reference.class (member_expression property: (property_identifier) @name.reference.class)]) @reference.class
`;

const PYTHON_QUERY = `
(class_definition name: (identifier) @name.definition.class) @definition.class
(function_definition name: (identifier) @name.definition.function) @definition.function
(expression_statement (assignment left: (identifier) @name.definition.const)) @definition.const
(call function: [(identifier) @name.reference.call (attribute attribute: (identifier) @name.reference.call)]) @reference.call
`;

const GO_QUERY = `
(function_declaration name: (identifier) @name.definition.function) @definition.function
(method_declaration name: (field_identifier) @name.definition.method) @definition.method
(method_elem name: (field_identifier) @name.definition.method) @definition.method
(type_spec name: (type_identifier) @name.definition.type) @definition.type
(call_expression function: [(identifier) @name.reference.call (selector_expression field: (field_identifier) @name.reference.call)]) @reference.call
(type_identifier) @name.reference.type
`;

const QUERIES: Readonly<Record<LanguageId, string>> = {
  typescript: TYPESCRIPT_QUERY,
  tsx: TSX_QUERY,
  javascript: JAVASCRIPT_QUERY,
  python: PYTHON_QUERY,
  go: GO_QUERY,
};

/** The tag query for a language. */
export function queryFor(language: LanguageId): string {
  return QUERIES[language];
}

/**
 * File under the tree `@s-h-a-d-o-w/tree-sitter-wasms/out` for each language. Kept as data so
 * a future native (`tree-sitter` + `tree-sitter-typescript`) backend can ignore it.
 */
export const WASM_FILES: Readonly<Record<LanguageId, string>> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
};

/** Definition captures that name a function-like construct (used to filter module-level consts). */
export const FUNCTION_LIKE_PARENT_TYPES: ReadonlySet<string> = new Set([
  // TypeScript / JavaScript
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'statement_block',
  // Python
  'function_definition',
  'decorated_definition',
  'lambda',
  // Go
  'func_literal',
]);
