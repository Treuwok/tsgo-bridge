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

test('findLspConflicts: manifest, .lsp.json and marketplace-declared servers; TS-only vs multi-language', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { findLspConflicts } = await import('../src/setup/conflicts.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tsgo-conflicts-'));
  const w = (p, j) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), JSON.stringify(j)); };
  // 1) multi-language plugin declaring servers inline in plugin.json (like a third-party "lsp-servers")
  w('cache/multi/.claude-plugin/plugin.json', { name: 'lsp-servers', lspServers: { typescript: { command: 'x', extensionToLanguage: { '.ts': 'typescript', '.tsx': 'typescriptreact' } }, python: { command: 'p', extensionToLanguage: { '.py': 'python' } }, go: { command: 'g', extensionToLanguage: { '.go': 'go' } } } });
  // 2) TS-only plugin using a .lsp.json file
  w('cache/vtsls/.lsp.json', { vtsls: { command: 'vtsls', extensionToLanguage: { '.ts': 'typescript', '.js': 'javascript' } } });
  // 3) official plugin whose servers live in the marketplace entry (strict: false)
  w('home/plugins/known_marketplaces.json', { official: { installLocation: path.join(root, 'mkt') } });
  w('mkt/.claude-plugin/marketplace.json', { plugins: [{ name: 'typescript-lsp', source: './plugins/typescript-lsp', strict: false, lspServers: { typescript: { command: 't', extensionToLanguage: { '.ts': 'typescript', '.mjs': 'javascript' } } } }] });
  // 4) unrelated plugin, and a disabled conflicting one
  w('cache/rust/.lsp.json', { ra: { command: 'ra', extensionToLanguage: { '.rs': 'rust' } } });
  const installed = [
    { id: 'lsp-servers@community', enabled: true, installPath: path.join(root, 'cache/multi') },
    { id: 'vtsls@other', enabled: false, installPath: path.join(root, 'cache/vtsls') }, // default off but enabled in settings below
    { id: 'typescript-lsp@official', enabled: true, installPath: path.join(root, 'cache/official-empty') },
    { id: 'rust@x', enabled: true, installPath: path.join(root, 'cache/rust') },
    { id: 'tsgo-lsp@tsgo-bridge', enabled: true, installPath: root },
    { id: 'off@x', enabled: true, installPath: path.join(root, 'cache/vtsls') },
  ];
  const enabled = { 'vtsls@other': true, 'off@x': false };
  const res = findLspConflicts({ dir: path.join(root, 'home') }, installed, enabled, 'tsgo-lsp@tsgo-bridge');
  const byId = Object.fromEntries(res.map(r => [r.id, r]));
  assert.deepEqual(Object.keys(byId).sort(), ['lsp-servers@community', 'typescript-lsp@official', 'vtsls@other']);
  assert.deepEqual(byId['lsp-servers@community'].overlap, ['.ts', '.tsx']);
  assert.deepEqual(byId['lsp-servers@community'].otherLanguages, ['Go', 'Python']);
  assert.deepEqual(byId['vtsls@other'].otherLanguages, []);
  assert.deepEqual(byId['typescript-lsp@official'].overlap, ['.mjs', '.ts']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('languageIdFor', () => {
  assert.equal(languageIdFor('a.tsx'), 'typescriptreact');
  assert.equal(languageIdFor('a.MTS'), 'typescript');
  assert.equal(languageIdFor('a.cjs'), 'javascript');
  assert.equal(languageIdFor('a.jsx'), 'javascriptreact');
});
