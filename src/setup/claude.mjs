// Claude Code integration: marketplace + plugin install, official typescript-lsp disable/restore.
//
// Enable/disable state is written straight into <home>/settings.json (`enabledPlugins`), which is what a
// session actually reads. `claude plugin enable/disable` is NOT used for that: when several config homes
// share one plugins/ directory (Orca profiles symlink it to ~/.claude/plugins), the CLI writes the flag to
// the settings file of the home that originally installed the plugin, not to CLAUDE_CONFIG_DIR. Verified
// on Claude Code 2.1.316 with a debug log of the LSP servers a session loads.
import fs from 'node:fs';
import path from 'node:path';
import { run, withEnv } from './exec.mjs';
import { findLspConflicts } from './conflicts.mjs';

export const MARKETPLACE = 'tsgo-bridge';
export const PLUGIN_ID = `tsgo-lsp@${MARKETPLACE}`;
export const OFFICIAL_ID = 'typescript-lsp@claude-plugins-official';

const claude = (home, args) => run('claude', args, { env: withEnv('CLAUDE_CONFIG_DIR', home.envValue) });
const settingsFile = home => path.join(home.dir, 'settings.json');

export function readEnabled(home) {
  try { return JSON.parse(fs.readFileSync(settingsFile(home), 'utf8')).enabledPlugins ?? {}; } catch { return {}; }
}

/** Set (or with value === undefined, remove) enabledPlugins[id] in <home>/settings.json, keeping the file's formatting. */
export function setEnabled(home, id, value) {
  const file = settingsFile(home);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  let obj = {};
  try { obj = text.trim() ? JSON.parse(text) : {}; } catch { throw new Error(`${file} is not valid JSON; not touching it`); }
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyRe = new RegExp(`("${esc}"\\s*:\\s*)(true|false)`);
  let out;
  if (value === undefined) {
    if (!obj.enabledPlugins || !(id in obj.enabledPlugins)) return false;
    delete obj.enabledPlugins[id];
    out = JSON.stringify(obj, null, 2) + '\n';
  } else if (obj.enabledPlugins && id in obj.enabledPlugins && keyRe.test(text)) {
    out = text.replace(keyRe, `$1${value}`);
  } else if (obj.enabledPlugins && /"enabledPlugins"\s*:\s*\{/.test(text)) {
    out = text.replace(/("enabledPlugins"\s*:\s*\{)(\s*)/, (_m, a, ws) => `${a}${ws || '\n    '}"${id}": ${value}${Object.keys(obj.enabledPlugins).length ? ',' : ''}${ws || '\n  '}`);
  } else {
    obj.enabledPlugins = { ...(obj.enabledPlugins ?? {}), [id]: value };
    out = JSON.stringify(obj, null, 2) + '\n';
  }
  const check = JSON.parse(out); // never write broken JSON
  if ((check.enabledPlugins ?? {})[id] !== value) throw new Error(`failed to update ${id} in ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out);
  return true;
}

function installedList(home) {
  const r = claude(home, ['plugin', 'list', '--json']);
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout).trim().slice(0, 300) };
  try { return { ok: true, list: JSON.parse(r.stdout) }; } catch { return { ok: false, error: 'unparseable plugin list' }; }
}

/** Effective state for a home: installed comes from the (possibly shared) registry, enabled from the home's settings.json. */
export function pluginStatus(home) {
  const inst = installedList(home);
  if (!inst.ok) return inst;
  const find = id => inst.list.find(p => p.id === id);
  const ours = find(PLUGIN_ID), official = find(OFFICIAL_ID);
  const en = readEnabled(home);
  return {
    ok: true,
    installed: !!ours, version: ours?.version,
    enabled: !!ours && en[PLUGIN_ID] === true,
    officialInstalled: !!official,
    officialEnabled: !!official && en[OFFICIAL_ID] === true,
    // every other enabled plugin that registers .ts/.tsx/.js/... (it would take those files from tsgo-lsp)
    conflicts: findLspConflicts(home, inst.list, en, PLUGIN_ID),
  };
}

function marketplaces(home) {
  const r = claude(home, ['plugin', 'marketplace', 'list', '--json']);
  if (!r.ok) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

/** Returns a list of { step, ok, detail } */
export function installClaude(home, { source, dryRun, state, disableConflicting = false }) {
  const steps = [];
  const step = (name, fn) => {
    if (dryRun) { steps.push({ step: name, ok: true, detail: 'dry-run' }); return true; }
    let r; try { r = fn(); } catch (e) { r = { ok: false, stderr: e.message }; }
    steps.push({ step: name, ok: r.ok, detail: r.ok ? (r.detail ?? '') : (r.stderr || r.stdout || r.error?.message || '').trim().slice(0, 400) });
    return r.ok;
  };
  const before = pluginStatus(home);
  if (!before.ok) return [{ step: 'claude plugin list', ok: false, detail: before.error }];

  const mk = marketplaces(home);
  const known = Array.isArray(mk) ? mk.some(m => m.name === MARKETPLACE) : false;
  if (known) step(`marketplace update ${MARKETPLACE}`, () => claude(home, ['plugin', 'marketplace', 'update', MARKETPLACE]));
  else if (!step(`marketplace add ${source}`, () => claude(home, ['plugin', 'marketplace', 'add', source]))) return steps;

  if (!before.installed) { if (!step(`install ${PLUGIN_ID}`, () => claude(home, ['plugin', 'install', PLUGIN_ID]))) return steps; }
  else step(`update ${PLUGIN_ID}`, () => claude(home, ['plugin', 'update', PLUGIN_ID]));

  const rec = migrateRecord(state.claude[home.dir] ??= {});
  step(`enable ${PLUGIN_ID} in ${settingsFile(home)}`, () => ({ ok: true, detail: setEnabled(home, PLUGIN_ID, true) ? '' : 'already' }));

  // Any other enabled plugin with a .ts/.js LSP server wins over tsgo-lsp, so it has to be turned off.
  // TS/JS-only plugins are disabled automatically; multi-language ones only with --disable-conflicting,
  // because disabling them also removes their other languages.
  for (const c of before.conflicts) {
    const what = `${c.id} (registers ${c.overlap.join(' ')})`;
    if (c.otherLanguages.length && !disableConflicting) {
      steps.push({ step: `CONFLICT: ${what}`, ok: false, detail: `it also serves ${c.otherLanguages.join(', ')}, so it was left enabled and tsgo-lsp will NOT be used for those files. Re-run setup with --disable-conflicting to disable it (you lose LSP for ${c.otherLanguages.join(', ')}), or disable just its TypeScript part if the plugin offers that.` });
      continue;
    }
    if (!(c.id in rec.disabled)) rec.disabled[c.id] = c.setting ?? null; // remember the exact prior value once
    step(`disable ${what}${c.otherLanguages.length ? ` — also loses ${c.otherLanguages.join(', ')}` : ''}`, () => ({ ok: setEnabled(home, c.id, false) }));
  }
  return steps;
}

/** state record: { disabled: { pluginId: previous enabledPlugins value | null } }; migrates 0.1.0/0.1.1 fields. */
function migrateRecord(rec) {
  rec.disabled ??= {};
  if ('officialSetting' in rec) { if (!(OFFICIAL_ID in rec.disabled)) rec.disabled[OFFICIAL_ID] = rec.officialSetting; delete rec.officialSetting; }
  if ('officialWasEnabled' in rec) { if (!(OFFICIAL_ID in rec.disabled)) rec.disabled[OFFICIAL_ID] = rec.officialWasEnabled ? true : null; delete rec.officialWasEnabled; }
  return rec;
}

/** Other homes (sharing the same plugin registry) that still have the plugin enabled. */
function otherUsers(home, allHomes) {
  return allHomes.filter(h => h.dir !== home.dir && readEnabled(h)[PLUGIN_ID] === true);
}

export function uninstallClaude(home, { dryRun, state, allHomes = [] }) {
  const steps = [];
  const step = (name, fn, allowFail = false) => {
    if (dryRun) { steps.push({ step: name, ok: true, detail: 'dry-run' }); return; }
    let r; try { r = fn(); } catch (e) { r = { ok: false, stderr: e.message }; }
    steps.push({ step: name, ok: r.ok || allowFail, detail: r.ok ? (r.detail ?? '') : (r.stderr || r.stdout || '').trim().slice(0, 300) });
  };
  const st = pluginStatus(home);
  const rec = state.claude[home.dir];
  step(`remove ${PLUGIN_ID} from ${settingsFile(home)}`, () => ({ ok: true, detail: setEnabled(home, PLUGIN_ID, undefined) ? '' : 'not set' }));
  if (rec) {
    for (const [id, raw] of Object.entries(migrateRecord(rec).disabled)) {
      const prev = raw === null ? undefined : raw;
      step(`restore ${id} = ${prev === undefined ? '(unset)' : prev}`, () => ({ ok: true, detail: setEnabled(home, id, prev) ? '' : 'unchanged' }));
    }
  }
  const others = otherUsers(home, allHomes);
  if (others.length) steps.push({ step: `keep shared install (still enabled in ${others.length} other home(s))`, ok: true, detail: others.map(h => h.label).join(', ') });
  else {
    if (st.ok && st.installed) step(`uninstall ${PLUGIN_ID}`, () => claude(home, ['plugin', 'uninstall', PLUGIN_ID]), true);
    step(`marketplace remove ${MARKETPLACE}`, () => claude(home, ['plugin', 'marketplace', 'remove', MARKETPLACE]), true);
  }
  if (!dryRun) delete state.claude[home.dir];
  return steps;
}
