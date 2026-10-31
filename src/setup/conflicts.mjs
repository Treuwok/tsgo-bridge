// Find other enabled Claude Code plugins that register an LSP server for the extensions tsgo-lsp handles.
// Claude Code gives an extension to the first plugin that registers it, so any such plugin silently wins
// over tsgo-lsp ("LSP server ... is not used for .ts files — plugin X already registered a server").
//
// LSP servers can be declared in three places; all are checked:
//   1. <installPath>/.claude-plugin/plugin.json  `lspServers` (inline map, path, or array of either)
//   2. <installPath>/.lsp.json
//   3. the marketplace entry for the plugin (e.g. typescript-lsp@claude-plugins-official, strict: false)
import fs from 'node:fs';
import path from 'node:path';
import { TS_EXTENSIONS } from '../text.mjs';

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** Normalize an `lspServers` value into a list of server configs. */
function serversFrom(value, baseDir) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(v => serversFrom(v, baseDir));
  if (typeof value === 'string') {
    const j = readJson(path.resolve(baseDir, value));
    return j ? serversFrom(j.lspServers ?? j, baseDir) : [];
  }
  if (typeof value === 'object') return Object.entries(value).filter(([, s]) => s && typeof s === 'object' && s.extensionToLanguage).map(([name, s]) => ({ name, ...s }));
  return [];
}

function marketplaceEntry(home, id) {
  const [name, mkt] = id.split('@');
  if (!mkt) return null;
  const known = readJson(path.join(home.dir, 'plugins', 'known_marketplaces.json')) ?? {};
  const loc = known[mkt]?.installLocation;
  if (!loc) return null;
  const manifest = readJson(path.join(loc, '.claude-plugin', 'marketplace.json'));
  const entry = manifest?.plugins?.find(p => p.name === name);
  if (!entry) return null;
  const src = typeof entry.source === 'string' ? path.resolve(loc, entry.source) : loc;
  return { entry, baseDir: src };
}

/** All LSP servers a plugin declares, as [{ name, extensionToLanguage }]. */
export function lspServersOf(home, plugin) {
  const out = [];
  if (plugin.installPath) {
    const m = readJson(path.join(plugin.installPath, '.claude-plugin', 'plugin.json'));
    out.push(...serversFrom(m?.lspServers, plugin.installPath));
    out.push(...serversFrom(readJson(path.join(plugin.installPath, '.lsp.json')), plugin.installPath));
  }
  const mk = marketplaceEntry(home, plugin.id);
  if (mk) out.push(...serversFrom(mk.entry.lspServers, mk.baseDir));
  const seen = new Set();
  return out.filter(s => { const k = s.name + JSON.stringify(s.extensionToLanguage); if (seen.has(k)) return false; seen.add(k); return true; });
}

const LANG_NAMES = { python: 'Python', go: 'Go', rust: 'Rust', java: 'Java', kotlin: 'Kotlin', csharp: 'C#', c: 'C', cpp: 'C++', ruby: 'Ruby', php: 'PHP', swift: 'Swift', lua: 'Lua', vue: 'Vue', svelte: 'Svelte', astro: 'Astro', html: 'HTML', css: 'CSS', scss: 'SCSS', json: 'JSON', yaml: 'YAML', markdown: 'Markdown' };

/**
 * @param home      { dir }
 * @param installed `claude plugin list --json` rows ({ id, enabled, installPath })
 * @param enabled   the home's settings.json enabledPlugins map
 * @param selfId    our plugin id (excluded)
 * @returns [{ id, setting, overlap: ['.ts', ...], otherLanguages: ['Python', ...] }]
 */
export function findLspConflicts(home, installed, enabled, selfId) {
  const ours = new Set(TS_EXTENSIONS);
  const res = [];
  for (const p of installed) {
    if (p.id === selfId) continue;
    const isOn = enabled[p.id] ?? p.enabled; // an unset entry falls back to the plugin's default state
    if (isOn !== true) continue;
    const servers = lspServersOf(home, p);
    const overlap = new Set(), others = new Set();
    for (const s of servers) {
      const exts = Object.keys(s.extensionToLanguage).map(e => e.toLowerCase());
      if (exts.some(e => ours.has(e))) exts.filter(e => ours.has(e)).forEach(e => overlap.add(e));
      // languages this plugin serves that tsgo-lsp does not: disabling the plugin would lose them
      for (const [ext, lang] of Object.entries(s.extensionToLanguage)) if (!ours.has(ext.toLowerCase())) others.add(LANG_NAMES[lang] ?? lang);
    }
    if (overlap.size) res.push({ id: p.id, setting: enabled[p.id], overlap: [...overlap].sort(), otherLanguages: [...others].sort() });
  }
  return res;
}
