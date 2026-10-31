// `tsgo-bridge doctor`: environment checks + end-to-end LSP and MCP self-tests + integration status.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveTsgo } from './resolve-tsgo.mjs';
import { lspClient, mcpClient, CLAUDE_CODE_CAPABILITIES } from './clients.mjs';
import { PKG_ROOT, VERSION, TS_VERSION, runtimeDir, userDataDir } from './paths.mjs';
import { claudeHomes, codexHomes } from './setup/homes.mjs';
import { pluginStatus, PLUGIN_ID, OFFICIAL_ID } from './setup/claude.mjs';
import { codexStatus, MCP_NAME, SKILL_NAME } from './setup/codex.mjs';
import { has } from './setup/exec.mjs';

const BIN = path.join(PKG_ROOT, 'bin', 'tsgo-bridge.mjs');

export function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsgo-bridge-'));
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['*.ts'] }));
  fs.writeFileSync(path.join(dir, 'math.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  fs.writeFileSync(path.join(dir, 'main.ts'), "import { add } from './math';\n\nexport const total: number = add(1, 2);\nexport const bad: number = 'oops';\n");
  return dir;
}

export async function selfTestLsp(dir) {
  const c = lspClient(process.execPath, [BIN, 'lsp'], { cwd: dir, env: { TSGO_IDLE_MS: '0' } });
  const rootUri = pathToFileURL(dir).href;
  const t0 = Date.now();
  const init = await c.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'fixture' }], capabilities: CLAUDE_CODE_CAPABILITIES, clientInfo: { name: 'Claude Code', version: 'doctor' } }, 180_000);
  if (init.error || init.timeout) return { ok: false, detail: `initialize: ${init.error?.message ?? 'timeout'} ${c.stderr.slice(0, 300)}` };
  c.notify('initialized', {});
  const file = path.join(dir, 'main.ts'), uri = pathToFileURL(file).href;
  const since = Date.now();
  c.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'typescript', version: 1, text: fs.readFileSync(file, 'utf8') } });
  const d = await c.waitDiagnostics(uri, since, items => items.some(i => /not assignable/.test(i.message)), 30_000);
  const h = await c.request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 9 } });
  await c.request('shutdown', null, 10_000); c.notify('exit', null);
  await Promise.race([c.exited, new Promise(r => setTimeout(r, 5000))]);
  const ok = !d.timeout && !!h.result && !init.result.capabilities.diagnosticProvider;
  return { ok, detail: `init ${since - t0}ms, pushed diagnostics ${d.timeout ? 'TIMEOUT' : d.ms + 'ms'}, hover ${h.result ? 'ok' : 'FAILED'}` };
}

export async function selfTestMcp(dir) {
  const c = mcpClient(process.execPath, [BIN, 'mcp'], { cwd: dir, env: { TSGO_IDLE_MS: '0' } });
  const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'doctor', version: VERSION } }, 30_000);
  if (init.error || init.timeout) return { ok: false, detail: `initialize: ${init.error?.message ?? 'timeout'}` };
  c.notify('notifications/initialized', {});
  const tools = await c.request('tools/list', {});
  const out = await c.call('ts_diagnostics', { files: ['main.ts'] }, 180_000);
  c.child.stdin.end();
  await Promise.race([c.exited, new Promise(r => setTimeout(r, 5000))]);
  const ok = (tools.result?.tools?.length ?? 0) >= 5 && /1 error/.test(out) && /TS2322/.test(out);
  return { ok, detail: ok ? `${tools.result.tools.length} tools; ts_diagnostics found the injected error` : out.slice(0, 400) };
}

export async function doctor({ json = false } = {}) {
  const checks = [];
  const add = (name, ok, detail = '') => { checks.push({ name, ok, detail }); if (!json) console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' — ' + detail : ''}`); };
  if (!json) console.log(`tsgo-bridge ${VERSION} (TypeScript ${TS_VERSION}) on ${process.platform}-${process.arch}, node ${process.version}\n`);

  add('node >= 20', Number(process.versions.node.split('.')[0]) >= 20, process.version);
  let tsgo;
  try { tsgo = resolveTsgo({ install: true, log: (...a) => !json && console.log('  ', ...a) }); add('TypeScript 7 native binary', true, `${tsgo.version} at ${tsgo.command}`); }
  catch (e) { add('TypeScript 7 native binary', false, e.message); }
  if (tsgo) {
    const v = spawnSync(tsgo.command, [...tsgo.args, '--version'], { encoding: 'utf8', windowsHide: true });
    add('tsgo runs', v.status === 0, v.stdout.trim());
    const dir = makeFixture();
    try {
      const l = await selfTestLsp(dir); add('LSP self-test (Claude Code path)', l.ok, l.detail);
      const m = await selfTestMcp(dir); add('MCP self-test (Codex path)', m.ok, m.detail);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  if (!json) console.log('');
  const cv = has('claude');
  if (!cv) add('Claude Code CLI', true, 'not found on PATH (skipped)');
  else for (const h of claudeHomes()) {
    const s = pluginStatus(h);
    if (!s.ok) { add(`Claude [${h.label}]`, false, s.error); continue; }
    // enabled state comes from this home's settings.json (what a session reads), not from the shared plugin registry
    const conflict = s.enabled && s.officialEnabled;
    const detail = !s.installed ? 'not installed (run: tsgo-bridge setup)'
      : !s.enabled ? `not enabled in this home (plugin v${s.version} is installed; run: tsgo-bridge setup --home "${h.dir}")`
      : `${PLUGIN_ID} enabled v${s.version}; ${OFFICIAL_ID} ${conflict ? 'ALSO ENABLED — two TypeScript servers will attach (run setup again)' : 'off'}`;
    add(`Claude [${h.label}] ${h.dir}`, !conflict, detail);
  }
  const xv = has('codex');
  if (!xv) add('Codex CLI', true, 'not found on PATH (skipped)');
  else for (const h of codexHomes()) {
    const s = codexStatus(h);
    add(`Codex [${h.label}] ${h.dir}`, (s.mcp && s.skill) || (!s.mcp && !s.skill), s.mcp || s.skill ? `mcp ${MCP_NAME}: ${s.mcp ? 'registered' : 'MISSING'}; skill ${SKILL_NAME}: ${s.skill ? 'present' : 'MISSING'}` : 'not installed (run: tsgo-bridge setup)');
  }
  if (!json) console.log(`\nruntime dir: ${runtimeDir()}\ndata dir:    ${userDataDir()}`);
  const ok = checks.every(c => c.ok);
  if (json) console.log(JSON.stringify({ ok, checks }, null, 2));
  return ok;
}
