// Text document helpers. LSP positions are UTF-16 code units; JS strings are UTF-16, so indices line up.

/** Convert an LSP position to a string offset (clamped to the line end / text end). */
export function offsetAt(text, pos) {
  let i = 0;
  for (let line = 0; line < pos.line; line++) {
    const n = text.indexOf('\n', i);
    if (n < 0) return text.length;
    i = n + 1;
  }
  const eol = text.indexOf('\n', i);
  const lineEnd = eol < 0 ? text.length : eol;
  return Math.min(i + Math.max(0, pos.character), lineEnd);
}

/** Apply LSP contentChanges (full or ranged) to text. */
export function applyContentChanges(text, changes) {
  for (const c of changes) {
    if (!c.range) { text = c.text; continue; }
    const s = offsetAt(text, c.range.start);
    const e = offsetAt(text, c.range.end);
    text = text.slice(0, s) + c.text + text.slice(e);
  }
  return text;
}

/** Return the 0-based line of text (without line terminator). */
export function lineAt(text, line) {
  const lines = text.split(/\r?\n/);
  return lines[line] ?? '';
}

export const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export function languageIdFor(file) {
  const f = file.toLowerCase();
  if (f.endsWith('.tsx')) return 'typescriptreact';
  if (f.endsWith('.jsx')) return 'javascriptreact';
  if (/\.(ts|mts|cts)$/.test(f)) return 'typescript';
  return 'javascript';
}
