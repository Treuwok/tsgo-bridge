// Claude Code integration: marketplace + plugin install, official typescript-lsp disable/restore.
import { run, withEnv } from './exec.mjs';

export const MARKETPLACE = 'tsgo-bridge';
export const PLUGIN_ID = `tsgo-lsp@${MARKETPLACE}`;
export const OFFICIAL_ID = 'typescript-lsp@claude-plugins-official';

const claude = (home, args) => run('claude', args, { env: withEnv('CLAUDE_CONFIG_DIR', home.envValue) });

export function pluginStatus(home) {
  const r = claude(home, ['plugin', 'list', '--json']);
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout).trim().slice(0, 300) };
  let list = [];
  try { list = JSON.parse(r.stdout); } catch { return { ok: false, error: 'unparseable plugin list' }; }
  const find = id => list.find(p => p.id === id);
  const ours = find(PLUGIN_ID), official = find(OFFICIAL_ID);
  return { ok: true, installed: !!ours, enabled: !!ours?.enabled, version: ours?.version, officialInstalled: !!official, officialEnabled: !!official?.enabled };
}

function marketplaces(home) {
  const r = claude(home, ['plugin', 'marketplace', 'list', '--json']);
  if (!r.ok) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

/** Returns a list of { step, ok, detail } */
export function installClaude(home, { source, dryRun, state }) {
  const steps = [];
  const step = (name, fn) => {
    if (dryRun) { steps.push({ step: name, ok: true, detail: 'dry-run' }); return true; }
    const r = fn();
    steps.push({ step: name, ok: r.ok, detail: r.ok ? '' : (r.stderr || r.stdout || r.error?.message || '').trim().slice(0, 400) });
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
  if (!before.enabled || !before.installed) step(`enable ${PLUGIN_ID}`, () => { const r = claude(home, ['plugin', 'enable', PLUGIN_ID]); return r.ok || /already enabled/i.test(r.stdout + r.stderr) ? { ...r, ok: true } : r; });

  // remember the official plugin's state once (first install), then disable it so two TS servers don't attach
  const rec = (state.claude[home.dir] ??= {});
  if (rec.officialWasEnabled === undefined) rec.officialWasEnabled = before.officialEnabled;
  if (before.officialEnabled) step(`disable ${OFFICIAL_ID}`, () => claude(home, ['plugin', 'disable', OFFICIAL_ID]));
  return steps;
}

export function uninstallClaude(home, { dryRun, state }) {
  const steps = [];
  const step = (name, fn, allowFail = false) => {
    if (dryRun) { steps.push({ step: name, ok: true, detail: 'dry-run' }); return; }
    const r = fn();
    steps.push({ step: name, ok: r.ok || allowFail, detail: r.ok ? '' : (r.stderr || r.stdout).trim().slice(0, 300) });
  };
  const st = pluginStatus(home);
  if (st.ok && st.installed) step(`uninstall ${PLUGIN_ID}`, () => claude(home, ['plugin', 'uninstall', PLUGIN_ID]));
  step(`marketplace remove ${MARKETPLACE}`, () => claude(home, ['plugin', 'marketplace', 'remove', MARKETPLACE]), true);
  const rec = state.claude[home.dir];
  if (rec?.officialWasEnabled && st.ok && st.officialInstalled && !st.officialEnabled) step(`re-enable ${OFFICIAL_ID}`, () => claude(home, ['plugin', 'enable', OFFICIAL_ID]));
  if (!dryRun) delete state.claude[home.dir];
  return steps;
}
