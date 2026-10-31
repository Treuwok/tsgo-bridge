#!/usr/bin/env node
// tsgo-bridge — TypeScript 7 (tsgo) for Claude Code (LSP) and Codex (MCP).
const [cmd = 'help', ...rest] = process.argv.slice(2);

function flags(argv) {
  const o = { home: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '-y' || a === '--yes') o.yes = true;
    else if (a === '--all-homes') o.allHomes = true;
    else if (a === '--claude-only') o.claudeOnly = true;
    else if (a === '--codex-only') o.codexOnly = true;
    else if (a === '--json') o.json = true;
    else if (a === '--disable-conflicting') o.disableConflicting = true;
    else if (a === '--home') o.home.push(argv[++i]);
    else if (a === '--source') o.source = argv[++i];
    else if (a === '--idle-minutes') o.idleMinutes = Number(argv[++i]);
    else { console.error(`unknown option: ${a}`); process.exit(2); }
  }
  o.idleMs = Math.round((Number.isFinite(o.idleMinutes) ? o.idleMinutes : 10) * 60_000);
  return o;
}

// Claude plugin passes minutes via userConfig; accept either form.
if (process.env.TSGO_IDLE_MS === undefined && process.env.TSGO_IDLE_MINUTES !== undefined) {
  const m = Number(process.env.TSGO_IDLE_MINUTES);
  if (Number.isFinite(m) && m >= 0) process.env.TSGO_IDLE_MS = String(Math.round(m * 60_000));
}

const HELP = `tsgo-bridge — TypeScript 7 (tsgo) code intelligence for Claude Code and Codex

Usage:
  tsgo-bridge setup      [--dry-run] [-y] [--all-homes] [--home <dir>]... [--claude-only|--codex-only]
                         [--source <github-owner/repo | git url | local path>] [--idle-minutes <n>]
                         [--disable-conflicting]  also disable multi-language LSP plugins that register .ts/.js
  tsgo-bridge uninstall  [--dry-run] [-y] [--home <dir>]... [--claude-only|--codex-only]
  tsgo-bridge doctor     [--json]
  tsgo-bridge lsp        stdio LSP server (used by the Claude Code plugin)
  tsgo-bridge mcp        stdio MCP server (used by Codex)
  tsgo-bridge version

Environment: TSGO_IDLE_MS / TSGO_IDLE_MINUTES (default 10 min, 0 = never stop), TSGO_BRIDGE_LOG=<file>,
             TSGO_TSC=<native binary>, TSGO_DIAG_DEBOUNCE_MS (50), TSGO_PULL_TO_PUSH=0, TSGO_BRIDGE_DATA=<dir>`;

switch (cmd) {
  case 'lsp': { const { runLspProxy } = await import('../src/lsp-proxy.mjs'); runLspProxy(); break; }
  case 'mcp': { const { runMcpServer } = await import('../src/mcp-server.mjs'); runMcpServer(); break; }
  case 'setup': { const { setup } = await import('../src/setup/index.mjs'); process.exitCode = (await setup(flags(rest))) ? 0 : 1; break; }
  case 'uninstall': { const { uninstall } = await import('../src/setup/index.mjs'); process.exitCode = (await uninstall(flags(rest))) ? 0 : 1; break; }
  case 'doctor': { const { doctor } = await import('../src/doctor.mjs'); process.exitCode = (await doctor(flags(rest))) ? 0 : 1; break; }
  case 'version': case '--version': case '-v': { const { VERSION, TS_VERSION } = await import('../src/paths.mjs'); console.log(`tsgo-bridge ${VERSION} (TypeScript ${TS_VERSION})`); break; }
  default: console.log(HELP); if (cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exitCode = 2;
}
