// Integration tests for the Claude Code path (LSP proxy) against the real TypeScript 7 native server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lspClient, CLAUDE_CODE_CAPABILITIES } from '../src/clients.mjs';
import { makeFixture } from '../src/doctor.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'tsgo-bridge.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let dir, logFile, c, uMain, uMath;
const IDLE = 1500;
const readLog = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } };
const count = re => (readLog().match(new RegExp(re.source, 'g')) ?? []).length;
async function waitLog(re, n = 1, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (count(re) >= n) return true; await sleep(50); }
  return false;
}
const publishes = uri => c.notifications.filter(x => x.m.method === 'textDocument/publishDiagnostics' && decodeURIComponent(x.m.params.uri).toLowerCase() === decodeURIComponent(uri).toLowerCase()).length;

before(async () => {
  dir = makeFixture();
  logFile = path.join(os.tmpdir(), `tsgo-bridge-test-${process.pid}.log`);
  fs.rmSync(logFile, { force: true });
  c = lspClient(process.execPath, [BIN, 'lsp'], { cwd: dir, env: { TSGO_IDLE_MS: String(IDLE), TSGO_BRIDGE_LOG: logFile } });
  uMain = pathToFileURL(path.join(dir, 'main.ts')).href;
  uMath = pathToFileURL(path.join(dir, 'math.ts')).href;
});
after(async () => {
  try { c.child.kill(); } catch {}
  await Promise.race([c.exited, sleep(5000)]);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

test('initialize hides diagnosticProvider and reports tsgo-bridge', async () => {
  const rootUri = pathToFileURL(dir).href;
  const r = await c.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'f' }], capabilities: CLAUDE_CODE_CAPABILITIES }, 180_000);
  assert.ok(r.result, JSON.stringify(r.error));
  assert.equal(r.result.capabilities.diagnosticProvider, undefined);
  assert.ok(r.result.capabilities.hoverProvider);
  assert.equal(r.result.serverInfo.name, 'tsgo-bridge');
  c.notify('initialized', {}); // must be swallowed (a second `initialized` panics tsgo)
});

test('didOpen pushes diagnostics (pull -> push)', async () => {
  const since = Date.now();
  c.notify('textDocument/didOpen', { textDocument: { uri: uMain, languageId: 'typescript', version: 1, text: fs.readFileSync(path.join(dir, 'main.ts'), 'utf8') } });
  const d = await c.waitDiagnostics(uMain, since, items => items.some(i => i.message.includes("'string' is not assignable to type 'number'")));
  assert.ok(!d.timeout, 'no diagnostics pushed');
  assert.doesNotMatch(readLog(), /panic/);
});

test('no-op save does not re-publish identical diagnostics', async () => {
  const n0 = publishes(uMain);
  c.notify('textDocument/didSave', { textDocument: { uri: uMain } });
  await sleep(1000);
  assert.equal(publishes(uMain), n0);
});

test('ranged didChange is applied and pushed', async () => {
  const since = Date.now();
  c.notify('textDocument/didChange', { textDocument: { uri: uMain, version: 2 }, contentChanges: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, text: 'const flag: boolean = 1;' }] });
  const d = await c.waitDiagnostics(uMain, since, items => items.some(i => i.message.includes("'number' is not assignable to type 'boolean'")));
  assert.ok(!d.timeout);
});

test('cross-file change re-pushes the dependent file', async () => {
  c.notify('textDocument/didOpen', { textDocument: { uri: uMath, languageId: 'typescript', version: 1, text: fs.readFileSync(path.join(dir, 'math.ts'), 'utf8') } });
  await sleep(300);
  const since = Date.now();
  c.notify('textDocument/didChange', { textDocument: { uri: uMath, version: 2 }, contentChanges: [{ text: 'export function add(a: number, b: number): string {\n  return String(a + b);\n}\n' }] });
  const d = await c.waitDiagnostics(uMain, since, items => items.filter(i => i.message.includes("'string' is not assignable to type 'number'")).length >= 2);
  assert.ok(!d.timeout, 'dependent file not re-pushed');
});

test('idle stop, then a request restarts tsgo and replays open documents', async () => {
  assert.ok(await waitLog(/stopping server/, 1, IDLE + 10_000), 'server did not stop when idle');
  assert.ok(await waitLog(/server exit/, 1));
  const n0 = publishes(uMain);
  const h = await c.request('textDocument/hover', { textDocument: { uri: uMain }, position: { line: 0, character: 9 } });
  assert.ok(h.result, 'hover after restart failed');
  assert.match(readLog(), /ready; replayed 2 docs/);
  await sleep(800);
  assert.equal(publishes(uMain), n0, 'unchanged diagnostics re-published after restart');
});

test('a change received while dormant is carried into the restarted server', async () => {
  assert.ok(await waitLog(/stopping server/, 2, IDLE + 10_000));
  assert.ok(await waitLog(/server exit/, 2));
  const since = Date.now();
  c.notify('textDocument/didChange', { textDocument: { uri: uMain, version: 3 }, contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: 'const z: string = 5;\n' }] });
  const d = await c.waitDiagnostics(uMain, since, items => items.some(i => i.message.includes("'number' is not assignable to type 'string'")), 30_000);
  assert.ok(!d.timeout);
});

test('crash of tsgo: read-only request is retried transparently', async () => {
  const pids = [...readLog().matchAll(/server pid (\d+)/g)].map(m => Number(m[1]));
  const pid = pids.at(-1);
  process.kill(pid);
  const r = await c.request('textDocument/references', { textDocument: { uri: uMath }, position: { line: 0, character: 17 }, context: { includeDeclaration: true } }, 60_000);
  assert.ok(Array.isArray(r.result) && r.result.length >= 2, `references after crash: ${JSON.stringify(r.error ?? r)}`);
});

test('shutdown + exit terminate the proxy', async () => {
  const r = await c.request('shutdown', null, 10_000);
  assert.ok(!r.timeout);
  c.notify('exit', null);
  const code = await Promise.race([c.exited, sleep(8000).then(() => 'timeout')]);
  assert.equal(code, 0);
});
