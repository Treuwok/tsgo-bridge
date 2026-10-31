// Discover agent configuration homes: defaults, env overrides, and Orca per-profile homes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orcaBaseDir } from '../paths.mjs';

const key = p => { let r = p; try { r = fs.realpathSync(p); } catch {} return process.platform === 'linux' ? r : r.toLowerCase(); };

function collect(entries) {
  const seen = new Map();
  for (const e of entries) {
    if (!e.dir || !fs.existsSync(e.dir)) continue;
    const k = key(e.dir);
    if (!seen.has(k)) seen.set(k, e); else if (e.current) seen.get(k).current = true;
  }
  return [...seen.values()];
}

function orcaHomes(sub, label) {
  const base = path.join(orcaBaseDir(), sub);
  let ents = [];
  try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  return ents.filter(e => e.isDirectory()).map(e => ({ dir: path.join(base, e.name, 'home'), label: `${label} ${e.name.slice(0, 8)}` }));
}

/** Claude Code config dirs. `envValue: null` means "unset CLAUDE_CONFIG_DIR" (the default ~/.claude). */
export function claudeHomes() {
  const def = path.join(os.homedir(), '.claude');
  const env = process.env.CLAUDE_CONFIG_DIR;
  return collect([
    ...(env ? [{ dir: env, label: 'current CLAUDE_CONFIG_DIR', current: true }] : []),
    { dir: def, label: 'default ~/.claude', current: !env },
    ...orcaHomes('claude-profiles', 'Orca Claude profile'),
  ]).map(h => ({ ...h, envValue: key(h.dir) === key(def) ? null : h.dir }));
}

/** Codex homes. `envValue: null` means "unset CODEX_HOME" (the default ~/.codex). */
export function codexHomes() {
  const def = path.join(os.homedir(), '.codex');
  const env = process.env.CODEX_HOME;
  return collect([
    ...(env ? [{ dir: env, label: 'current CODEX_HOME', current: true }] : []),
    { dir: def, label: 'default ~/.codex', current: !env },
    ...orcaHomes('codex-accounts', 'Orca Codex account'),
  ]).map(h => ({ ...h, envValue: key(h.dir) === key(def) ? null : h.dir }));
}
