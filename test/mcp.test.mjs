// Integration tests for the Codex path (MCP server) against the real TypeScript 7 native server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mcpClient } from '../src/clients.mjs';
import { makeFixture } from '../src/doctor.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'tsgo-bridge.mjs');
let dir, c;
const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });

before(async () => {
  dir = makeFixture();
  c = mcpClient(process.execPath, [BIN, 'mcp'], { cwd: dir, env: { TSGO_IDLE_MS: '0' } });
  const r = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.ok(r.result);
  c.notify('notifications/initialized', {});
});
after(async () => {
  try { c.child.stdin.end(); } catch {}
  await Promise.race([c.exited, new Promise(r => setTimeout(r, 5000))]);
  try { c.child.kill(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); // Windows: tsgo may still hold the dir briefly
});

test('tools/list exposes the five tools', async () => {
  const r = await c.request('tools/list', {});
  assert.deepEqual(r.result.tools.map(t => t.name).sort(), ['ts_definition', 'ts_diagnostics', 'ts_hover', 'ts_references', 'ts_symbols']);
});

test('ts_diagnostics reports the error, then 0 after a fix on disk', async () => {
  let out = await c.call('ts_diagnostics', { files: ['main.ts', 'math.ts'] }, 180_000);
  assert.match(out, /1 error\(s\)/);
  assert.match(out, /main\.ts:4:14 error TS2322/);
  fs.writeFileSync(path.join(dir, 'main.ts'), "import { add } from './math';\n\nexport const total: number = add(1, 2);\n");
  out = await c.call('ts_diagnostics', { files: ['main.ts'] });
  assert.match(out, /0 error\(s\)/);
});

test('cross-file edit on disk is seen when checking the dependent file', async () => {
  fs.writeFileSync(path.join(dir, 'math.ts'), 'export function add(a: number, b: number): string {\n  return String(a + b);\n}\n');
  const out = await c.call('ts_diagnostics', { files: ['main.ts'] });
  assert.match(out, /main\.ts:3:14 error TS2322/);
  fs.writeFileSync(path.join(dir, 'math.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
});

test('ts_definition / ts_references / ts_hover / ts_symbols', async () => {
  const def = await c.call('ts_definition', { file: 'main.ts', line: 3, symbol: 'add' });
  assert.match(def, /math\.ts:1:17/);
  const refs = await c.call('ts_references', { file: 'math.ts', line: 1, symbol: 'add' });
  assert.match(refs, /reference\(s\)/);
  assert.match(refs, /main\.ts/);
  const hover = await c.call('ts_hover', { file: 'main.ts', line: 3, symbol: 'add' });
  assert.match(hover, /function add\(a: number, b: number\): number/);
  const syms = await c.call('ts_symbols', { query: 'add' });
  assert.match(syms, /function add/);
});

test('ts_diagnostics without files uses git changed files', { skip: spawnSync('git', ['--version']).status !== 0 }, async () => {
  git('init', '-q'); git('add', '-A'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'extra.ts'), 'export const n: number = "x";\n');
  const out = await c.call('ts_diagnostics', {});
  assert.match(out, /Checked 1 file/);
  assert.match(out, /extra\.ts:1:14 error TS2322/);
});

test('files outside the workspace are refused', async () => {
  const outside = path.join(path.dirname(dir), `tsgo-bridge-outside-${process.pid}.ts`);
  fs.writeFileSync(outside, 'export const secret = 1;\n');
  try {
    assert.match(await c.call('ts_hover', { file: outside, line: 1 }), /refusing to read outside the workspace/);
    assert.match(await c.call('ts_diagnostics', { files: [outside] }), /refusing to read outside the workspace/);
  } finally { fs.rmSync(outside, { force: true }); }
});

test('unknown file and unknown symbol produce readable errors', async () => {
  const a = await c.call('ts_hover', { file: 'nope.ts', line: 1 });
  assert.match(a, /file not found/);
  const b = await c.call('ts_definition', { file: 'main.ts', line: 1, symbol: 'doesNotExist' });
  assert.match(b, /not found on line 1/);
});
