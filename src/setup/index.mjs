// `tsgo-bridge setup` / `tsgo-bridge uninstall`
import readline from 'node:readline/promises';
import path from 'node:path';
import { claudeHomes, codexHomes } from './homes.mjs';
import { installClaude, uninstallClaude } from './claude.mjs';
import { ensureCodexRuntime, installCodex, uninstallCodex } from './codex.mjs';
import { loadState, saveState } from './state.mjs';
import { has } from './exec.mjs';
import { resolveTsgo } from '../resolve-tsgo.mjs';
import { VERSION, TS_VERSION } from '../paths.mjs';

export const DEFAULT_SOURCE = 'treuwok/tsgo-bridge';

function pickHomes(all, opts) {
  const same = (a, b) => { const n = p => path.resolve(p); return process.platform === 'linux' ? n(a) === n(b) : n(a).toLowerCase() === n(b).toLowerCase(); };
  if (opts.home?.length) return all.filter(h => opts.home.some(x => same(x, h.dir)));
  if (opts.allHomes) return all;
  return all.filter(h => h.current);
}

function printSteps(title, steps) {
  console.log(`\n${title}`);
  for (const s of steps) console.log(`  ${s.ok ? '✔' : '✘'} ${s.step}${s.detail ? ` — ${s.detail}` : ''}`);
}

async function confirm(question, yes) {
  if (yes || !process.stdin.isTTY) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

export async function setup(opts) {
  const doClaude = !opts.codexOnly, doCodex = !opts.claudeOnly;
  const claudeV = doClaude ? has('claude') : null, codexV = doCodex ? has('codex') : null;
  const cHomes = claudeV ? pickHomes(claudeHomes(), opts) : [];
  const xHomes = codexV ? pickHomes(codexHomes(), opts) : [];
  console.log(`tsgo-bridge ${VERSION} setup (TypeScript ${TS_VERSION}, ${process.platform}-${process.arch})${opts.dryRun ? ' — DRY RUN' : ''}`);
  console.log(`  Claude Code: ${claudeV ?? (doClaude ? 'not found' : 'skipped')}`);
  for (const h of cHomes) console.log(`    → ${h.label}: ${h.dir}`);
  console.log(`  Codex:       ${codexV ?? (doCodex ? 'not found' : 'skipped')}`);
  for (const h of xHomes) console.log(`    → ${h.label}: ${h.dir}`);
  const others = [...(claudeV ? claudeHomes() : []), ...(codexV ? codexHomes() : [])].filter(h => !cHomes.includes(h) && !xHomes.includes(h) && !cHomes.some(c => c.dir === h.dir) && !xHomes.some(c => c.dir === h.dir));
  if (others.length && !opts.allHomes && !opts.home?.length) console.log(`  (${others.length} other config home(s) found; use --all-homes or --home <dir> to include them)`);
  if (!cHomes.length && !xHomes.length) { console.log('\nNothing to do.'); return false; }
  if (!opts.dryRun && !(await confirm('Proceed?', opts.yes))) { console.log('Aborted.'); return false; }

  const state = loadState();
  let ok = true;
  if (!opts.dryRun) {
    // prewarm the runtime used by the Claude plugin when it runs without CLAUDE_PLUGIN_DATA (and validate the platform)
    try { const t = resolveTsgo({ install: true, log: (...a) => console.log('  ', ...a) }); console.log(`\n✔ TypeScript ${t.version} native binary: ${t.command}`); }
    catch (e) { console.log(`\n✘ TypeScript runtime: ${e.message}`); return false; }
  }
  for (const h of cHomes) {
    const steps = installClaude(h, { source: opts.source ?? DEFAULT_SOURCE, dryRun: opts.dryRun, state });
    printSteps(`Claude Code [${h.label}]`, steps); ok &&= steps.every(s => s.ok);
  }
  if (xHomes.length) {
    let runtime;
    try { runtime = ensureCodexRuntime({ dryRun: opts.dryRun, log: (...a) => console.log('  ', ...a) }); }
    catch (e) { console.log(`\n✘ Codex runtime: ${e.message}`); return false; }
    for (const h of xHomes) {
      const steps = installCodex(h, { runtime, idleMs: opts.idleMs, dryRun: opts.dryRun });
      printSteps(`Codex [${h.label}] (runtime ${runtime})`, steps); ok &&= steps.every(s => s.ok);
      if (!opts.dryRun) state.codex[h.dir] = { runtime, version: VERSION };
    }
  }
  if (!opts.dryRun) saveState(state);
  console.log(ok ? '\nDone. Start a new Claude Code / Codex session to load it. Verify with: tsgo-bridge doctor' : '\nFinished with errors (see ✘ above).');
  return ok;
}

export async function uninstall(opts) {
  const state = loadState();
  const cHomes = !opts.codexOnly && has('claude') ? pickHomes(claudeHomes(), { ...opts, allHomes: opts.allHomes ?? true }) : [];
  const xHomes = !opts.claudeOnly && has('codex') ? pickHomes(codexHomes(), { ...opts, allHomes: opts.allHomes ?? true }) : [];
  console.log(`tsgo-bridge uninstall${opts.dryRun ? ' — DRY RUN' : ''}`);
  if (!opts.dryRun && !(await confirm(`Remove tsgo-bridge from ${cHomes.length} Claude and ${xHomes.length} Codex home(s)?`, opts.yes))) { console.log('Aborted.'); return false; }
  for (const h of cHomes) printSteps(`Claude Code [${h.label}]`, uninstallClaude(h, { dryRun: opts.dryRun, state }));
  for (const h of xHomes) { printSteps(`Codex [${h.label}]`, uninstallCodex(h, { dryRun: opts.dryRun })); if (!opts.dryRun) delete state.codex[h.dir]; }
  if (!opts.dryRun) saveState(state);
  return true;
}
