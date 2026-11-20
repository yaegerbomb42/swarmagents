/**
 * Minimal indentation-based YAML parser for role files.
 *
 * Supported subset:
 * - Scalars: unquoted, single-quoted, double-quoted (basic escapes)
 * - Maps (`key: value` or `key:` followed by an indented block)
 * - Lists (`- item` or `- key: value` for list-of-maps)
 * - Nested maps and lists, comments (`#` to end of line outside quotes)
 * - `true` / `false` / `null` / `~` / integers / floats
 *
 * Not supported: anchors, tags, flow `[...]` / `{...}` collections,
 * multiline `|` / `>` literals, merge keys, or complex keys.
 */

interface Line {
  indent: number;
  text: string;
}

function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (c === '"' && !inSingle) {
      if (inDouble && line[i - 1] === '\\') continue;
      inDouble = !inDouble;
      continue;
    }
    if (c === '#' && !inSingle && !inDouble) return line.slice(0, i).trimEnd();
  }
  return line;
}

function linesOf(src: string): Line[] {
  const out: Line[] = [];
  for (const raw of src.split(/\r?\n/)) {
    const noComment = stripComment(raw);
    if (noComment.trim() === '') continue;
    const indent = noComment.match(/^ */)?.[0].length ?? 0;
    out.push({ indent, text: noComment.slice(indent) });
  }
  return out;
}

function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s
      .slice(1, -1)
      .replace(/\\(\\|"|n|r|t|b|f)/g, (_, ch: string) => {
        const map: Record<string, string> = {
          '\\': '\\',
          '"': '"',
          n: '\n',
          r: '\r',
          t: '\t',
          b: '\b',
          f: '\f',
        };
        return map[ch] ?? ch;
      });
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return Number.parseFloat(s);
  return s;
}

function isListItem(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

function parseBlock(lines: Line[], start: number, indent: number): { value: unknown; next: number } {
  if (start >= lines.length) return { value: {}, next: start };
  const first = lines[start];
  if (!first || first.indent < indent) return { value: {}, next: start };
  if (isListItem(first.text) && first.indent === indent) {
    return parseList(lines, start, indent);
  }
  return parseMap(lines, start, indent);
}

function parseMap(lines: Line[], start: number, indent: number): { value: Record<string, unknown>; next: number } {
  const obj: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || line.indent < indent) break;
    if (line.indent > indent) {
      throw new Error(`Unexpected indent at "${line.text}"`);
    }
    if (isListItem(line.text)) break;
    const colon = line.text.indexOf(':');
    if (colon < 0) {
      throw new Error(`Expected key: value, got "${line.text}"`);
    }
    const key = line.text.slice(0, colon).trim();
    const rest = line.text.slice(colon + 1).trim();
    i += 1;
    if (rest.length > 0) {
      obj[key] = parseScalar(rest);
      continue;
    }
    const next = lines[i];
    if (!next || next.indent <= indent) {
      obj[key] = null;
      continue;
    }
    const child = parseBlock(lines, i, next.indent);
    obj[key] = child.value;
    i = child.next;
  }
  return { value: obj, next: i };
}

function parseList(lines: Line[], start: number, indent: number): { value: unknown[]; next: number } {
  const arr: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || line.indent < indent) break;
    if (line.indent > indent || !isListItem(line.text)) break;
    const rest = line.text === '-' ? '' : line.text.slice(2).trim();
    i += 1;
    const next = lines[i];
    if (rest.length === 0) {
      if (next && next.indent > indent) {
        const child = parseBlock(lines, i, next.indent);
        arr.push(child.value);
        i = child.next;
      } else {
        arr.push(null);
      }
      continue;
    }
    if (rest.includes(':') && !rest.startsWith('"') && !rest.startsWith("'")) {
      // `- key: value` starts a list-of-maps item. The first field lives at
      // indent+2 (after the dash and space); following lines keep their indent.
      const fieldIndent = indent + 2;
      const synthetic: Line[] = [{ indent: fieldIndent, text: rest }];
      let j = i;
      while (j < lines.length) {
        const cont = lines[j];
        if (!cont || cont.indent <= indent) break;
        if (isListItem(cont.text) && cont.indent === indent) break;
        synthetic.push({ indent: cont.indent, text: cont.text });
        j += 1;
      }
      const child = parseMap(synthetic, 0, fieldIndent);
      arr.push(child.value);
      i = j;
      continue;
    }
    arr.push(parseScalar(rest));
  }
  return { value: arr, next: i };
}

export function parseYaml(src: string): unknown {
  const lines = linesOf(src);
  if (lines.length === 0) return {};
  const first = lines[0];
  if (!first) return {};
  // A bare document of one un-keyed scalar (e.g. `hello`, `null`, `"x"`).
  if (lines.length === 1 && !isListItem(first.text) && !first.text.includes(':')) {
    return parseScalar(first.text);
  }
  const { value } = parseBlock(lines, 0, first.indent);
  return value;
}
