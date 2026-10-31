// Codex integration: stable runtime copy + `codex mcp add` + skill.
import fs from 'node:fs';
import path from 'node:path';
import { run, withEnv } from './exec.mjs';
import { PKG_ROOT, VERSION, userDataDir } from '../paths.mjs';
import { installRuntime } from '../resolve-tsgo.mjs';

export const MCP_NAME = 'tsgo';
export const SKILL_NAME = 'tsgo-typecheck';
const COPY = ['bin', 'src', 'codex', 'package.json', 'README.md', 'LICENSE'];

const codex = (home, args) => run('codex', args, { env: withEnv('CODEX_HOME', home.envValue) });

/** Copy this package to a versioned, stable location (npx caches are ephemeral) and install TypeScript into it. */
export function ensureCodexRuntime({ dryRun, log = () => {} } = {}) {
  const dest = path.join(userDataDir(), 'runtime', VERSION);
  if (dryRun) return dest;
  if (path.resolve(dest) !== path.resolve(PKG_ROOT)) {
    fs.mkdirSync(dest, { recursive: true });
    for (const item of COPY) {
      const src = path.join(PKG_ROOT, item);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(dest, item), { recursive: true, force: true });
    }
  }
  installRuntime(dest, log); // node_modules/typescript inside dest -> resolveTsgo finds it as "local"
  pruneOldRuntimes(path.dirname(dest), VERSION);
  return dest;
}

function pruneOldRuntimes(dir, keep) {
  let ents = [];
  try { ents = fs.readdirSync(dir).filter(n => n !== keep).map(n => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t); } catch { return; }
  for (const e of ents.slice(1)) fs.rmSync(path.join(dir, e.n), { recursive: true, force: true }); // keep current + 1 previous
}

/** Prefer an absolute node path, unless it lives in a per-shell temp dir (fnm multishell, volta shims). */
export function nodeCommand() {
  return /fnm_multishells|[\\/]\.volta[\\/]|[\\/]nvs[\\/]/i.test(process.execPath) ? 'node' : process.execPath;
}

export function codexStatus(home) {
  const r = codex(home, ['mcp', 'get', MCP_NAME]);
  const skill = fs.existsSync(path.join(home.dir, 'skills', SKILL_NAME, 'SKILL.md'));
  return { ok: true, mcp: r.ok, mcpDetail: r.ok ? r.stdout.trim() : '', skill };
}

export function installCodex(home, { runtime, idleMs, dryRun }) {
  const steps = [];
  const node = nodeCommand();
  const entry = path.join(runtime, 'bin', 'tsgo-bridge.mjs');
  const add = ['mcp', 'add', MCP_NAME, '--env', `TSGO_IDLE_MS=${idleMs}`, '--', node, entry, 'mcp'];
  if (dryRun) {
    steps.push({ step: `codex ${add.join(' ')}`, ok: true, detail: 'dry-run' });
    steps.push({ step: `copy skill -> ${path.join(home.dir, 'skills', SKILL_NAME)}`, ok: true, detail: 'dry-run' });
    return steps;
  }
  codex(home, ['mcp', 'remove', MCP_NAME]); // replace any previous registration
  const r = codex(home, add);
  steps.push({ step: `codex mcp add ${MCP_NAME}`, ok: r.ok, detail: r.ok ? `${node} ${entry} mcp` : (r.stderr || r.stdout).trim().slice(0, 400) });
  try {
    const dst = path.join(home.dir, 'skills', SKILL_NAME);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(path.join(PKG_ROOT, 'codex', 'skills', SKILL_NAME), dst, { recursive: true });
    steps.push({ step: `skill ${SKILL_NAME}`, ok: true, detail: dst });
  } catch (e) { steps.push({ step: `skill ${SKILL_NAME}`, ok: false, detail: e.message }); }
  return steps;
}

export function uninstallCodex(home, { dryRun }) {
  const steps = [];
  if (dryRun) return [{ step: `codex mcp remove ${MCP_NAME} + remove skill`, ok: true, detail: 'dry-run' }];
  const r = codex(home, ['mcp', 'remove', MCP_NAME]);
  steps.push({ step: `codex mcp remove ${MCP_NAME}`, ok: true, detail: r.ok ? '' : 'not registered' });
  fs.rmSync(path.join(home.dir, 'skills', SKILL_NAME), { recursive: true, force: true });
  steps.push({ step: `remove skill ${SKILL_NAME}`, ok: true, detail: '' });
  return steps;
}
