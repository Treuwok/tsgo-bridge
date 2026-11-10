// Working set: Claude Code never sends didClose, so every edited file stays open in tsgo, and tsgo keeps every
// project that has an open file (one set per git worktree, each with its own node_modules). These tests pin the
// release of idle workspaces, parking and reviving, the MCP document limit, and the diagnostics pulls (one per
// document at a time).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TsgoManager } from '../src/tsgo-manager.mjs';
import { lspClient, CLAUDE_CODE_CAPABILITIES } from '../src/clients.mjs';
import { makeFixture } from '../src/doctor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fake-tsgo.mjs');
const BIN = path.join(HERE, '..', 'bin', 'tsgo-bridge.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsgo-ws-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

/** A git worktree-like directory (has a `.git` entry) with the given files. Returns { dir, uri(name) }. */
function workspace(name, files = { 'x.ts': 'export const x = 1;\n' }) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
  return { dir, uri: f => pathToFileURL(path.join(dir, f)).href };
}
const records = file => { try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
async function waitFor(pred, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (pred()) return true; await sleep(20); }
  return false;
}
function fakeManager(logFile, opts) {
  return new TsgoManager({ resolveCommand: () => ({ command: process.execPath, args: [FAKE] }), initParams: { capabilities: {} }, idleMs: 0, env: { ...process.env, FAKE_TSGO_LOG: logFile }, ...opts });
}
/** didOpen/didClose sequence tsgo received, once `lastUri` was opened `times` times. */
async function openCloseSeq(log, names, lastUri, times = 1) {
  assert.ok(await waitFor(() => records(log).filter(r => r.method === 'textDocument/didOpen' && r.uri === lastUri).length >= times), 'last didOpen never arrived');
  // the throwaway untitled document of the idle check is pinned by its own test
  return records(log).filter(r => /did(Open|Close)$/.test(r.method) && names.has(r.uri)).map(r => `${r.method.split('/')[1]} ${names.get(r.uri)}`);
}
async function stop(c) { c.child.kill(); await Promise.race([c.exited, sleep(5000)]); }
const IDLE = 300; // workspace idle time used by the fake-tsgo tests

test('a workspace unused for the idle time is parked; workspaces in use are all kept', async () => {
  const [a, b, c] = ['a', 'b', 'c'].map(n => workspace(`idle-${n}`));
  const [uA, uB, uC] = [a, b, c].map(w => w.uri('x.ts'));
  const names = new Map([[uA, 'A'], [uB, 'B'], [uC, 'C']]);
  const log = path.join(tmp, 'idle.log');
  const mgr = fakeManager(log, { workspaceIdleMs: IDLE });
  try {
    await mgr.ready();
    mgr.openDoc(uA, 'typescript', 1, 'export const a = 1;\n');
    await sleep(IDLE + 300); // the idle check (every 200 ms here) parks it
    mgr.openDoc(uB, 'typescript', 1, 'export const b = 1;\n'); // A is idle: parked first
    mgr.openDoc(uC, 'typescript', 1, 'export const c = 1;\n'); // B is in use: kept, however many workspaces there are
    // didClose A must reach tsgo before didOpen B: tsgo drops projects without open files only while it handles a didOpen
    assert.deepEqual(await openCloseSeq(log, names, uC), ['didOpen A', 'didClose A', 'didOpen B', 'didOpen C']);

    // the client still has A open and sends a ranged edit: A comes back with its parked text, then gets the edit,
    // and B and C (used just now) stay open
    assert.equal(mgr.changeDoc(uA, 2, [{ range: { start: { line: 0, character: 13 }, end: { line: 0, character: 14 } }, text: 'alpha' }]), true);
    assert.deepEqual((await openCloseSeq(log, names, uA, 2)).slice(4), ['didOpen A']);
    assert.equal(records(log).findLast(r => r.method === 'textDocument/didOpen').text, 'export const a = 1;\n');
    assert.equal(mgr.docs.get(uA).text, 'export const alpha = 1;\n');
    assert.deepEqual([...mgr.docs.keys()], [uB, uC, uA]);
  } finally { await mgr.close(); }
});

test('opening a new file in a parked workspace brings its parked files back, in their order', async () => {
  const a = workspace('sib-a', { 'x.ts': '', 'y.ts': '', 'z.ts': '' }), b = workspace('sib-b');
  const names = new Map([[a.uri('x.ts'), 'Ax'], [a.uri('y.ts'), 'Ay'], [a.uri('z.ts'), 'Az'], [b.uri('x.ts'), 'Bx']]);
  const log = path.join(tmp, 'sib.log');
  const mgr = fakeManager(log, { workspaceIdleMs: IDLE });
  const reopened = [];
  mgr.on('reopen', uris => reopened.push(...uris.map(u => names.get(u))));
  try {
    await mgr.ready();
    mgr.openDoc(a.uri('x.ts'), 'typescript', 1, '');
    mgr.openDoc(a.uri('y.ts'), 'typescript', 1, '');
    await sleep(IDLE + 300); // the idle check (every 200 ms here) parks it
    mgr.openDoc(b.uri('x.ts'), 'typescript', 1, ''); // parks A
    mgr.openDoc(a.uri('z.ts'), 'typescript', 1, ''); // the agent's first edit of another file in A
    const seq = await openCloseSeq(log, names, a.uri('z.ts'));
    assert.deepEqual(seq.slice(2), ['didClose Ax', 'didClose Ay', 'didOpen Bx', 'didOpen Ax', 'didOpen Ay', 'didOpen Az']);
    assert.deepEqual([...mgr.docs.keys()].map(u => names.get(u)), ['Bx', 'Ax', 'Ay', 'Az']);
    assert.deepEqual(reopened, ['Ax', 'Ay']); // the proxy pulls their diagnostics again
  } finally { await mgr.close(); }
});

test('a call-hierarchy request on a parked document (uri in params.item) brings its workspace back first', async () => {
  const a = workspace('ch-a'), b = workspace('ch-b');
  const names = new Map([[a.uri('x.ts'), 'A'], [b.uri('x.ts'), 'B']]);
  const log = path.join(tmp, 'ch.log');
  const mgr = fakeManager(log, { workspaceIdleMs: IDLE });
  try {
    await mgr.ready();
    mgr.openDoc(a.uri('x.ts'), 'typescript', 1, '');
    await sleep(IDLE + 300); // the idle check (every 200 ms here) parks it
    mgr.openDoc(b.uri('x.ts'), 'typescript', 1, ''); // parks A
    await mgr.request('callHierarchy/incomingCalls', { item: { uri: a.uri('x.ts'), name: 'x', kind: 13, range: {}, selectionRange: {} } });
    const seq = records(log).filter(r => (/did(Open|Close)$/.test(r.method) && names.has(r.uri)) || r.method.endsWith('incomingCalls')).map(r => r.method.endsWith('incomingCalls') ? 'incomingCalls' : `${r.method.split('/')[1]} ${names.get(r.uri)}`);
    assert.deepEqual(seq, ['didOpen A', 'didClose A', 'didOpen B', 'didOpen A', 'incomingCalls']);
  } finally { await mgr.close(); }
});

test('the idle check releases an unused workspace while the agent only edits open files (no didOpen)', async () => {
  const a = workspace('tick-a'), b = workspace('tick-b');
  const log = path.join(tmp, 'tick.log');
  const mgr = fakeManager(log, { idleMs: 60_000, workspaceIdleMs: IDLE });
  try {
    await mgr.ready();
    mgr.openDoc(a.uri('x.ts'), 'typescript', 1, '');
    mgr.openDoc(b.uri('x.ts'), 'typescript', 1, '');
    for (let v = 2; v <= 12; v++) { mgr.changeDoc(b.uri('x.ts'), v, [{ text: `${v}` }]); mgr.markUsed(b.uri('x.ts')); await sleep(80); }
    assert.ok(await waitFor(() => records(log).some(r => r.method === 'textDocument/didClose' && r.uri === a.uri('x.ts')), 3000), 'idle A was not released');
    const recs = records(log);
    const closeA = recs.findIndex(r => r.method === 'textDocument/didClose' && r.uri === a.uri('x.ts'));
    // a throwaway didOpen after the close is what makes tsgo remove the project
    assert.ok(recs.slice(closeA).some(r => r.method === 'textDocument/didOpen' && r.uri.startsWith('untitled:')), 'no didOpen made tsgo drop the project');
    assert.ok(!recs.some(r => r.method === 'textDocument/didClose' && r.uri === b.uri('x.ts')), 'the workspace in use was closed');
  } finally { await mgr.close(); }
});

test('after an idle stop, the next edit restarts tsgo with only its own workspace', async () => {
  const a = workspace('restart-a'), b = workspace('restart-b');
  const log = path.join(tmp, 'restart.log');
  const mgr = fakeManager(log, { idleMs: IDLE, workspaceIdleMs: IDLE });
  try {
    await mgr.ready();
    mgr.openDoc(a.uri('x.ts'), 'typescript', 1, '');
    mgr.openDoc(b.uri('x.ts'), 'typescript', 1, '');
    // edit B while tsgo is still stopping: the edit must still bring tsgo back afterwards
    await new Promise((res, rej) => { mgr.once('idle-stop', res); setTimeout(() => rej(new Error('tsgo did not stop when idle')), 5000); });
    mgr.changeDoc(b.uri('x.ts'), 2, [{ text: 'export const b = 2;\n' }]);
    assert.ok(await waitFor(() => records(log).filter(r => r.method === 'initialize').length >= 2, 10_000), 'no restart');
    await sleep(200);
    const recs = records(log);
    const reopened = recs.slice(recs.findLastIndex(r => r.method === 'initialize')).filter(r => r.method === 'textDocument/didOpen').map(r => r.uri);
    assert.deepEqual(reopened, [b.uri('x.ts')]);
  } finally { await mgr.close(); }
});

test('parking idle workspaces does not postpone the idle stop of the whole server', async () => {
  const a = workspace('deadline-a');
  const mgr = fakeManager(path.join(tmp, 'deadline.log'), { idleMs: 1000, workspaceIdleMs: 1000 }); // idle check every 250 ms
  try {
    await mgr.ready();
    mgr.openDoc(a.uri('x.ts'), 'typescript', 1, '');
    const t0 = Date.now();
    await new Promise((res, rej) => { mgr.once('idle-stop', res); setTimeout(() => rej(new Error('no idle stop')), 5000); });
    const waited = Date.now() - t0;
    assert.ok(waited < 1700, `stopped after ${waited} ms; the idle time is 1000 ms (+ one 250 ms check)`);
  } finally { await mgr.close(); }
});

test('more open documents than maxDocs closes the least recently used one, which an edit does not bring back', async () => {
  const w = workspace('docs', { 'a.ts': '', 'b.ts': '', 'c.ts': '' });
  const names = new Map(['a.ts', 'b.ts', 'c.ts'].map(f => [w.uri(f), f]));
  const log = path.join(tmp, 'docs.log');
  const mgr = fakeManager(log, { maxDocs: 2 });
  try {
    await mgr.ready();
    for (const f of ['a.ts', 'b.ts', 'c.ts']) mgr.openDoc(w.uri(f), 'typescript', 1, '');
    assert.deepEqual(await openCloseSeq(log, names, w.uri('c.ts')), ['didOpen a.ts', 'didOpen b.ts', 'didClose a.ts', 'didOpen c.ts']);
    assert.equal(mgr.changeDoc(w.uri('a.ts'), 2, [{ text: 'x' }]), false); // MCP re-reads closed files from disk
  } finally { await mgr.close(); }
});

test('a request after close() answers with an error instead of waiting forever', async () => {
  const mgr = fakeManager(path.join(tmp, 'closed.log'));
  await mgr.ready();
  await mgr.close();
  const r = await Promise.race([mgr.request('textDocument/hover', {}), sleep(2000).then(() => 'hang')]);
  assert.notEqual(r, 'hang');
  assert.ok(r.error);
});

/** LSP proxy on the fake tsgo, initialized with Claude Code's capabilities. */
async function fakeProxy(dir, env) {
  const c = lspClient(process.execPath, [BIN, 'lsp'], { cwd: dir, env: { TSGO_TSC: FAKE, TSGO_IDLE_MS: '0', ...env } });
  const init = await c.request('initialize', { processId: process.pid, rootUri: pathToFileURL(dir).href, capabilities: CLAUDE_CODE_CAPABILITIES });
  assert.ok(init.result, JSON.stringify(init.error ?? init));
  return c;
}
const open = (c, uri) => c.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'typescript', version: 1, text: '' } });
const edit = (c, uri, v) => c.notify('textDocument/didChange', { textDocument: { uri, version: v }, contentChanges: [{ text: `export const v = ${v};\n` }] });

const lastMessage = (c, uri) => c.notifications.filter(x => x.m.method === 'textDocument/publishDiagnostics' && x.m.params.uri === uri).at(-1)?.m.params.diagnostics[0]?.message;
const publishCount = (c, uri) => c.notifications.filter(x => x.m.method === 'textDocument/publishDiagnostics' && x.m.params.uri === uri).length;

test('one diagnostics pull per document at a time; results keep coming during fast edits and the last edit is published', async () => {
  const w = workspace('flight', { 'a.ts': '', 'b.ts': '', 'c.ts': '' });
  const log = path.join(tmp, 'flight.log');
  const c = await fakeProxy(w.dir, { FAKE_TSGO_LOG: log, FAKE_DIAG_DELAY_MS: '400' });
  try {
    for (const f of ['a.ts', 'b.ts', 'c.ts']) open(c, w.uri(f));
    await sleep(600);
    const before = publishCount(c, w.uri('a.ts'));
    for (let v = 2; v <= 16; v++) { edit(c, w.uri('a.ts'), v); await sleep(100); } // faster than one pull
    const during = publishCount(c, w.uri('a.ts')) - before;
    assert.ok(await waitFor(() => lastMessage(c, w.uri('a.ts')) === 'export const v = 16;\n', 10_000), `last result for a.ts: ${JSON.stringify(lastMessage(c, w.uri('a.ts')))}`);
    const pulls = records(log).filter(r => r.method === 'textDocument/diagnostic');
    assert.equal(Math.max(...pulls.map(r => r.inFlightForUri)), 1, 'two pulls of one document were in flight together');
    assert.ok(Math.max(...pulls.map(r => r.inFlight)) <= 3, `tsgo had ${Math.max(...pulls.map(r => r.inFlight))} diagnostic requests in flight for 3 documents`);
    assert.ok(during >= 2, `only ${during} result(s) for a.ts were published while it was being edited`);
  } finally { await stop(c); }
});

test('a document parked while its diagnostics are in flight still gets them', async () => {
  const b = workspace('inflight-b'), c2 = workspace('inflight-c');
  const c = await fakeProxy(b.dir, { FAKE_DIAG_DELAY_MS: '1500', TSGO_IDLE_MS: String(IDLE) });
  try {
    c.notify('textDocument/didOpen', { textDocument: { uri: b.uri('x.ts'), languageId: 'typescript', version: 1, text: 'B1' } });
    await sleep(IDLE + 300); // B is idle and the idle check parks it, while B's pull is still in flight
    open(c, c2.uri('x.ts'));
    assert.ok(await waitFor(() => lastMessage(c, b.uri('x.ts')) === 'B1', 5000), 'the result for parked B was dropped');
  } finally { await stop(c); }
});

test('a diagnostics request that tsgo never answers does not delay other documents', async () => {
  const w = workspace('hang', { 'hang.ts': '', 'a.ts': '' });
  const c = await fakeProxy(w.dir, { FAKE_DIAG_HANG: 'hang.ts' });
  try {
    open(c, w.uri('hang.ts'));
    open(c, w.uri('a.ts'));
    for (let v = 2; v <= 3; v++) {
      edit(c, w.uri('a.ts'), v);
      assert.ok(await waitFor(() => lastMessage(c, w.uri('a.ts')) === `export const v = ${v};\n`, 3000), `edit ${v} of a.ts got no diagnostics while hang.ts is unanswered`);
    }
  } finally { await stop(c); }
});

// ---- real TypeScript 7 server ----

test('real tsgo: a worktree left idle is released while another one is edited; an edit on it brings it back without reloading the one in use', async () => {
  const dirA = makeFixture(), dirB = makeFixture();
  for (const d of [dirA, dirB]) fs.mkdirSync(path.join(d, '.git'));
  const uA = pathToFileURL(path.join(dirA, 'main.ts')).href, uB = pathToFileURL(path.join(dirB, 'main.ts')).href;
  const textB = fs.readFileSync(path.join(dirB, 'main.ts'), 'utf8');
  const c = lspClient(process.execPath, [BIN, 'lsp'], { cwd: dirA, env: { TSGO_IDLE_MS: '1500' } });
  // tsgo logs this when it removes a project because none of its files is open
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const deleted = dir => c.notifications.filter(x => x.m.method === 'window/logMessage' && new RegExp(`Deleting configured project: .*${esc(path.basename(dir))}.*tsconfig\\.json`, 'i').test(String(x.m.params?.message))).length;
  try {
    const init = await c.request('initialize', { processId: process.pid, rootUri: pathToFileURL(dirA).href, capabilities: CLAUDE_CODE_CAPABILITIES }, 180_000);
    assert.ok(init.result, JSON.stringify(init.error ?? init));
    c.notify('initialized', {});
    let since = Date.now();
    c.notify('textDocument/didOpen', { textDocument: { uri: uA, languageId: 'typescript', version: 1, text: fs.readFileSync(path.join(dirA, 'main.ts'), 'utf8') } });
    assert.ok(!(await c.waitDiagnostics(uA, since, items => items.length > 0)).timeout, 'A not checked');
    c.notify('textDocument/didOpen', { textDocument: { uri: uB, languageId: 'typescript', version: 1, text: textB } });
    // the agent keeps editing B only (no new didOpen); A goes idle and must be released anyway
    for (let v = 2; v <= 12 && deleted(dirA) === 0; v++) {
      c.notify('textDocument/didChange', { textDocument: { uri: uB, version: v }, contentChanges: [{ text: `${textB}// ${v}\n` }] });
      await sleep(400);
    }
    assert.ok(await waitFor(() => deleted(dirA) >= 1, 5000), 'tsgo kept the project of idle A');

    // a ranged edit on parked A: A comes back with its text and the edit is applied; B (in use) is not touched
    since = Date.now();
    c.notify('textDocument/didChange', { textDocument: { uri: uA, version: 2 }, contentChanges: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, text: 'const flag: boolean = 1;' }] });
    const d = await c.waitDiagnostics(uA, since, items => items.some(i => i.message.includes("'number' is not assignable to type 'boolean'")), 30_000);
    assert.ok(!d.timeout, 'ranged edit of a parked document was not applied');
    assert.ok(d.items.some(i => i.message.includes("'string' is not assignable to type 'number'")), 'the parked text was lost');
    assert.equal(deleted(dirB), 0, 'the worktree in use was reloaded');
  } finally {
    await stop(c);
    for (const d of [dirA, dirB]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
