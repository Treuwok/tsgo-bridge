# tsgo-bridge

tsgo-bridge connects Claude Code and Codex to the TypeScript 7 native language server (tsgo). It works on Windows, macOS, and Linux.

[繁體中文說明](README.zh-TW.md)

## What it does

tsgo-bridge gives the agent TypeScript and JavaScript code intelligence from tsgo:

- Type errors after each edit.
- Go to definition.
- Find references.
- Hover information and document symbols.

In Claude Code, the agent gets this information through the LSP plugin. In Codex, the agent gets it through MCP tools (`ts_diagnostics`, `ts_definition`, `ts_references`, `ts_hover`, `ts_symbols`).

## Benefits

| | tsserver 6 (official plugin) | tsgo-bridge |
|---|---|---|
| Memory (monorepo, 8 open packages) | approximately 3.9 GB | approximately 1.9 GB |
| Memory after 10 idle minutes | no change | approximately 58 MB (tsgo stops) |
| Time from edit to type errors | 1.5 to 8 seconds | 0.1 to 2.4 seconds |
| Codex | no TypeScript tools | 5 MCP tools and a skill |

- **The agent sees its own type errors.** After an edit, the agent gets the errors in the next step. It can correct them before it continues.
- **The agent finds code by meaning.** It can use definitions and references instead of a text search. A text search can find words that have the same name but a different meaning.
- **Less memory.** tsgo uses approximately half the memory of tsserver. Each session starts its own server, so the saving increases with the number of sessions.
- **Idle stop.** tsgo-bridge stops tsgo after 10 idle minutes. The next request starts it again in approximately 1 second.
- **One install for two clients.** One `setup` command installs the Claude Code plugin and the Codex MCP server. It works on Windows, macOS, and Linux.
- **No change to your projects.** tsgo-bridge uses a private copy of TypeScript 7 for the agent only. Your project builds continue to use the TypeScript version of the project.
- **Reversible.** `uninstall` removes tsgo-bridge and enables the plugins that setup disabled.

The numbers come from tests on one Windows computer. Your results can be different.

## Why this exists

tsgo-bridge is a temporary bridge. It exists because tsgo and the agent clients do not work together directly at this time.

1. **tsgo does not push diagnostics.** The TypeScript 7 language server sends per-file diagnostics only when the client asks for them (pull, `textDocument/diagnostic`). It does not send `textDocument/publishDiagnostics` (push).
2. **Claude Code accepts only pushed diagnostics.** Claude Code does not ask the server for diagnostics. If you connect tsgo directly to Claude Code, Claude Code shows no type errors after an edit.
3. **Codex has no LSP client.** Codex cannot use any language server directly. It can use MCP servers.

These issues track the problem. Status on 2026-11-01:

| Item | Proposed change | Status |
|---|---|---|
| [microsoft/TypeScript#63928](https://github.com/microsoft/TypeScript/issues/63928) | tsgo pushes diagnostics to clients that do not pull | Open, label "Needs Investigation" |
| [microsoft/TypeScript#63921](https://github.com/microsoft/TypeScript/pull/63921) | Pull request that adds the push | Open, not merged, review required. No update since 2026-08-20. |
| [anthropics/claude-code#101041](https://github.com/anthropics/claude-code/issues/101041) | Claude Code pulls diagnostics from the server | Open, label "enhancement" |

tsgo-bridge also contains two workarounds for tsgo:

- It does not send a second `initialized` notification to tsgo. tsgo stops with an error if it gets two.
- It does not tell tsgo that the client watches files. tsgo then watches the files itself.

### When to remove it

You can remove the Claude Code part when one of these conditions is true:

- tsgo sends pushed diagnostics.
- Claude Code asks the server for diagnostics (pull).

Before you remove it, set `TSGO_PULL_TO_PUSH=0` and check that Claude Code still shows type errors. tsgo-bridge then only passes messages between Claude Code and tsgo, and stops tsgo when it is idle.

You can remove the Codex part when Codex has an LSP client.

## How it works

- **Claude Code**: The plugin `tsgo-lsp` adds an LSP server. TypeScript 7 sends diagnostics only when the client asks for them (pull). Claude Code accepts only diagnostics that the server sends (push). tsgo-bridge asks tsgo for the diagnostics and sends them to Claude Code.
- **Codex**: Codex has no LSP client. tsgo-bridge adds the MCP server `tsgo` and the skill `tsgo-typecheck`. The skill tells Codex to check types after it edits a TypeScript file.

## Requirements

- Node.js 20 or later, with npm.
- git.
- Claude Code CLI, Codex CLI, or both.
- Access to the private repository `github.com/treuwok/tsgo-bridge` (for example, run `gh auth login`).

## Install

1. Show the changes that setup will make. This command does not change your settings.

   ```bash
   npx -y github:treuwok/tsgo-bridge setup --dry-run
   ```

2. Install.

   ```bash
   npx -y github:treuwok/tsgo-bridge setup
   ```

3. Check the installation.

   ```bash
   npx -y github:treuwok/tsgo-bridge doctor
   ```

4. Start a new Claude Code or Codex session.

Setup disables other plugins that also register an LSP server for `.ts` or `.js` files. Claude Code gives each file extension to the first plugin that registers it. If a different plugin keeps `.ts`, Claude Code does not use tsgo-lsp.

If a conflicting plugin also serves other languages (for example, Python), setup does not disable it. Setup shows `CONFLICT` and the languages that you will lose. To disable the plugin, run setup again with `--disable-conflicting`.

## Options

| Option | Description |
|---|---|
| `--dry-run` | Show the changes. Do not make them. |
| `-y` | Do not ask for confirmation. |
| `--all-homes` | Install in all configuration directories that setup finds. |
| `--home <dir>` | Install in this configuration directory. |
| `--claude-only` / `--codex-only` | Install for one client only. |
| `--idle-minutes <n>` | Stop the Codex server after `n` idle minutes. The default is 10. Use 0 to never stop it. |
| `--disable-conflicting` | Also disable multi-language plugins that register `.ts` or `.js` files. |

## Uninstall

```bash
npx -y github:treuwok/tsgo-bridge uninstall
```

Uninstall removes the plugin, the MCP server, and the skill. It also enables the plugins that setup disabled.

## Limitations

- TypeScript 7 is stricter than TypeScript 5 and 6. It can show errors that your project build does not show.
- tsgo-bridge does not load TypeScript plugins from `tsconfig.json` (for example, the Next.js plugin).
- tsgo-bridge does not support Vue, Svelte, or Astro templates.
- After an idle stop, the first request takes approximately 1 second longer.

## Development

```bash
npm install
npm test
node bin/tsgo-bridge.mjs doctor
```

For the design and the test results, see `docs/`.
