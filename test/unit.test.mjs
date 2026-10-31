import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readLsp, frameLsp, readNdjson, frameNdjson } from '../src/jsonrpc.mjs';
import { applyContentChanges, offsetAt, languageIdFor } from '../src/text.mjs';

test('LSP framing survives split chunks and multi-byte UTF-8', async () => {
  const s = new PassThrough(); const got = [];
  readLsp(s, m => got.push(m));
  const a = frameLsp({ id: 1, text: '中文 ✓ émoji 🎉' }), b = frameLsp({ id: 2, text: 'x' });
  const all = Buffer.concat([a, b]);
  for (let i = 0; i < all.length; i += 3) s.write(all.subarray(i, i + 3)); // split inside multi-byte chars
  await new Promise(r => setImmediate(r));
  assert.deepEqual(got, [{ id: 1, text: '中文 ✓ émoji 🎉' }, { id: 2, text: 'x' }]);
});

test('NDJSON framing handles partial lines', async () => {
  const s = new PassThrough(); const got = [];
  readNdjson(s, m => got.push(m));
  const t = frameNdjson({ a: 1 }) + frameNdjson({ b: '中' });
  s.write(t.slice(0, 5)); s.write(t.slice(5));
  await new Promise(r => setImmediate(r));
  assert.deepEqual(got, [{ a: 1 }, { b: '中' }]);
});

test('offsetAt clamps to line end and text end', () => {
  const t = 'ab\ncde\n';
  assert.equal(offsetAt(t, { line: 0, character: 1 }), 1);
  assert.equal(offsetAt(t, { line: 0, character: 99 }), 2);
  assert.equal(offsetAt(t, { line: 1, character: 2 }), 5);
  assert.equal(offsetAt(t, { line: 9, character: 0 }), t.length);
});

test('applyContentChanges: full and ranged edits (incl. CRLF and surrogate pairs)', () => {
  assert.equal(applyContentChanges('abc', [{ text: 'xyz' }]), 'xyz');
  const t = 'line1\r\nli🎉ne2\r\n';
  // replace "ne" after the emoji (emoji = 2 UTF-16 units) on line 1
  assert.equal(applyContentChanges(t, [{ range: { start: { line: 1, character: 4 }, end: { line: 1, character: 6 } }, text: 'NE' }]), 'line1\r\nli🎉NE2\r\n');
  assert.equal(applyContentChanges('a\nb', [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: 'X' }, { range: { start: { line: 1, character: 1 }, end: { line: 1, character: 1 } }, text: 'Y' }]), 'Xa\nbY');
});

test('setEnabled edits only the enabledPlugins entry and keeps formatting', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { setEnabled, readEnabled } = await import('../src/setup/claude.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsgo-settings-'));
  const home = { dir };
  const original = '{\n  "env": {\n    "A": "1"\n  },\n  "enabledPlugins": {\n    "x@y": true,\n    "typescript-lsp@claude-plugins-official": true\n  },\n  "theme": "dark"\n}\n';
  fs.writeFileSync(path.join(dir, 'settings.json'), original);
  setEnabled(home, 'typescript-lsp@claude-plugins-official', false);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), original.replace('"typescript-lsp@claude-plugins-official": true', '"typescript-lsp@claude-plugins-official": false'));
  setEnabled(home, 'tsgo-lsp@tsgo-bridge', true);
  const after = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  assert.match(after, /"enabledPlugins": \{\n {4}"tsgo-lsp@tsgo-bridge": true,\n {4}"x@y": true,/);
  assert.match(after, /"theme": "dark"/);
  assert.deepEqual(readEnabled(home), { 'tsgo-lsp@tsgo-bridge': true, 'x@y': true, 'typescript-lsp@claude-plugins-official': false });
  setEnabled(home, 'tsgo-lsp@tsgo-bridge', undefined);
  assert.equal(readEnabled(home)['tsgo-lsp@tsgo-bridge'], undefined);
  // missing file / no enabledPlugins
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tsgo-settings-'));
  setEnabled({ dir: d2 }, 'tsgo-lsp@tsgo-bridge', true);
  assert.deepEqual(readEnabled({ dir: d2 }), { 'tsgo-lsp@tsgo-bridge': true });
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(d2, { recursive: true, force: true });
});

test('languageIdFor', () => {
  assert.equal(languageIdFor('a.tsx'), 'typescriptreact');
  assert.equal(languageIdFor('a.MTS'), 'typescript');
  assert.equal(languageIdFor('a.cjs'), 'javascript');
  assert.equal(languageIdFor('a.jsx'), 'javascriptreact');
});
