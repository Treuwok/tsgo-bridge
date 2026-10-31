// MCP (stdio, newline-delimited JSON-RPC) frontend for agents without an LSP client (Codex CLI).
// Tools: ts_diagnostics, ts_hover, ts_definition, ts_references, ts_symbols.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readNdjson, frameNdjson, isRequest, isNotification, isResponse } from './jsonrpc.mjs';
import { TsgoManager } from './tsgo-manager.mjs';
import { resolveTsgo } from './resolve-tsgo.mjs';
import { createLogger } from './log.mjs';
import { TS_EXTENSIONS, languageIdFor, lineAt } from './text.mjs';
import { VERSION, TS_VERSION } from './paths.mjs';

const MAX_OPEN = 50;
const MAX_ITEMS = 200;
const SEVERITY = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };
const SYMBOL_KIND = { 2: 'module', 3: 'namespace', 5: 'class', 6: 'method', 7: 'property', 8: 'field', 9: 'constructor', 10: 'enum', 11: 'interface', 12: 'function', 13: 'variable', 14: 'constant', 22: 'enumMember', 23: 'struct', 26: 'typeParameter' };

const posSchema = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'File path (absolute or relative to the workspace root)' },
    line: { type: 'integer', minimum: 1, description: '1-based line number' },
    column: { type: 'integer', minimum: 1, description: '1-based column. Optional when `symbol` is given.' },
    symbol: { type: 'string', description: 'Identifier on that line; used to find the column when `column` is omitted' },
  },
  required: ['file', 'line'],
};

export const TOOLS = [
  {
    name: 'ts_diagnostics',
    description: 'Type-check TypeScript/JavaScript files with the TypeScript 7 (tsgo) language server and return compiler errors and warnings. Call this after editing .ts/.tsx/.js files. Omit `files` to check every changed file in the git working tree.',
    inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, description: 'Files to check. Default: changed + untracked TS/JS files from git.' }, includeHints: { type: 'boolean', description: 'Also return hints such as unused variables. Default false.' } } },
  },
  { name: 'ts_hover', description: 'Show the TypeScript type / signature / docs of the symbol at a position.', inputSchema: posSchema },
  { name: 'ts_definition', description: 'Go to the definition of the symbol at a position (semantic, not text search).', inputSchema: posSchema },
  { name: 'ts_references', description: 'Find all references of the symbol at a position across the project (semantic, not text search).', inputSchema: posSchema },
  { name: 'ts_symbols', description: 'Search workspace symbols (classes, functions, types, variables) by name.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, file: { type: 'string', description: 'Any file inside the project to search (selects the workspace). Optional.' } }, required: ['query'] } },
];

export function runMcpServer({ stdin = process.stdin, stdout = process.stdout, env = process.env, cwd = process.cwd(), exit = code => process.exit(code) } = {}) {
  const log = createLogger(env.TSGO_BRIDGE_LOG, 'mcp');
  const idleMs = env.TSGO_IDLE_MS !== undefined ? Number(env.TSGO_IDLE_MS) : 600_000;
  const send = msg => { try { stdout.write(frameNdjson(msg)); } catch {} };
  const managers = new Map(); // root -> { mgr, lru: Map<uri, true> }
  let roots = []; // absolute paths from roots/list
  let clientCaps = {};
  let seq = 0;
  const pendingClient = new Map();

  // ---------- workspace / files ----------
  const norm = p => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
  function gitRoot(dir) {
    for (let d = dir; ; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, '.git'))) return d;
      if (path.dirname(d) === d) return null;
    }
  }
  function rootFor(file) {
    const f = norm(file);
    const hit = roots.filter(r => f.startsWith(norm(r) + path.sep) || f === norm(r)).sort((a, b) => b.length - a.length)[0];
    return hit ?? gitRoot(path.dirname(file)) ?? (norm(file).startsWith(norm(cwd)) ? cwd : path.dirname(file));
  }
  function defaultRoot() { return roots[0] ?? gitRoot(cwd) ?? cwd; }
  function absPath(p, base = defaultRoot()) { return path.resolve(base, p); }
  function rel(file, root) { const r = path.relative(root, file); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : file; }

  function workspace(root) {
    let w = managers.get(root);
    if (w) return w;
    const rootUri = pathToFileURL(root).href;
    const initParams = {
      rootUri, rootPath: root, workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
      clientInfo: { name: 'tsgo-bridge-mcp', version: VERSION },
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        workspace: { workspaceFolders: true, symbol: {}, configuration: false, didChangeWatchedFiles: { dynamicRegistration: false } },
        textDocument: {
          synchronization: { didSave: true }, publishDiagnostics: {}, diagnostic: { dynamicRegistration: false },
          hover: { contentFormat: ['plaintext', 'markdown'] }, definition: { linkSupport: true }, references: {}, implementation: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        },
      },
    };
    const mgr = new TsgoManager({ resolveCommand: () => resolveTsgo({ log }), initParams, idleMs, log, env });
    mgr.on('notification', () => {});
    w = { mgr, root, lru: new Map() };
    managers.set(root, w);
    log('workspace', root);
    return w;
  }

  /** Make the server's view of `file` match the disk. Returns { w, uri, text }. */
  function sync(file) {
    const w = workspace(rootFor(file));
    const uri = pathToFileURL(file).href;
    const text = fs.readFileSync(file, 'utf8');
    const d = w.mgr.docs.get(uri);
    if (!d) w.mgr.openDoc(uri, languageIdFor(file), 1, text);
    else if (d.text !== text) w.mgr.changeDoc(uri, d.version + 1, [{ text }]);
    w.lru.delete(uri); w.lru.set(uri, true);
    while (w.lru.size > MAX_OPEN) { const old = w.lru.keys().next().value; w.lru.delete(old); w.mgr.closeDoc(old); }
    return { w, uri, text };
  }
  /** Re-sync every open document of a workspace (catches cross-file edits the server may not have seen yet). */
  function resyncOpen(w) {
    for (const uri of [...w.mgr.docs.keys()]) {
      let file; try { file = fileURLToPath(uri); } catch { continue; }
      if (!fs.existsSync(file)) { w.mgr.closeDoc(uri); w.lru.delete(uri); continue; }
      const text = fs.readFileSync(file, 'utf8');
      const d = w.mgr.docs.get(uri);
      if (d && d.text !== text) w.mgr.changeDoc(uri, d.version + 1, [{ text }]);
    }
  }
  function changedFiles(root) {
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (top.status !== 0) return [];
    const base = top.stdout.trim();
    const out = [];
    for (const args of [['diff', '--name-only', 'HEAD'], ['ls-files', '--others', '--exclude-standard']]) {
      const r = spawnSync('git', args, { cwd: base, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      if (r.status === 0) out.push(...r.stdout.split('\n').map(s => s.trim()).filter(Boolean));
    }
    return [...new Set(out)].filter(f => TS_EXTENSIONS.some(e => f.toLowerCase().endsWith(e)) && !f.endsWith('.d.ts')).map(f => path.resolve(base, f)).filter(f => fs.existsSync(f)).slice(0, 100);
  }

  // ---------- tools ----------
  const text = s => ({ content: [{ type: 'text', text: s }] });
  const fail = s => ({ content: [{ type: 'text', text: s }], isError: true });

  function position(args) {
    const file = absPath(args.file);
    if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
    const { w, uri, text: src } = sync(file);
    const lineText = lineAt(src, args.line - 1);
    let character;
    if (args.column) character = args.column - 1;
    else if (args.symbol) {
      const re = new RegExp(`(?<![\\w$])${args.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`);
      const m = re.exec(lineText);
      if (!m) throw new Error(`symbol "${args.symbol}" not found on line ${args.line}: ${lineText.trim()}`);
      character = m.index;
    } else character = Math.max(0, lineText.search(/\S/));
    return { w, uri, file, pos: { line: args.line - 1, character } };
  }

  function locations(result) {
    if (!result) return [];
    const arr = Array.isArray(result) ? result : [result];
    return arr.map(l => (l.targetUri ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : { uri: l.uri, range: l.range })).filter(l => l.uri && l.range);
  }
  function formatLocations(locs, root) {
    const cache = new Map();
    return locs.slice(0, MAX_ITEMS).map(l => {
      let file; try { file = fileURLToPath(l.uri); } catch { return l.uri; }
      if (!cache.has(file)) { try { cache.set(file, fs.readFileSync(file, 'utf8')); } catch { cache.set(file, ''); } }
      const src = lineAt(cache.get(file), l.range.start.line).trim();
      return `${rel(file, root)}:${l.range.start.line + 1}:${l.range.start.character + 1}  ${src.length > 160 ? src.slice(0, 160) + '…' : src}`;
    }).join('\n') + (locs.length > MAX_ITEMS ? `\n… ${locs.length - MAX_ITEMS} more` : '');
  }

  const handlers = {
    async ts_diagnostics(args = {}) {
      const root0 = defaultRoot();
      let files = (args.files?.length ? args.files.map(f => absPath(f)) : changedFiles(root0));
      if (!files.length) return text('No changed TypeScript/JavaScript files found in the git working tree. Pass `files` explicitly.');
      const missing = files.filter(f => !fs.existsSync(f));
      files = files.filter(f => fs.existsSync(f));
      const seen = new Set();
      for (const f of files) { const w = workspace(rootFor(f)); if (!seen.has(w)) { seen.add(w); resyncOpen(w); } }
      const results = await Promise.all(files.map(async f => {
        const { w, uri } = sync(f);
        const items = await w.mgr.pullDiagnostics(uri);
        return { f, w, items };
      }));
      const lines = []; let errors = 0, warnings = 0, shown = 0;
      for (const { f, w, items } of results) {
        if (items === null) { lines.push(`${rel(f, w.root)}: (diagnostics unavailable)`); continue; }
        for (const d of items) {
          const sev = SEVERITY[d.severity ?? 1] ?? 'error';
          if (sev === 'hint' && !args.includeHints) continue;
          if (sev === 'error') errors++; else if (sev === 'warning') warnings++;
          if (shown++ < MAX_ITEMS) lines.push(`${rel(f, w.root)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev}${d.code !== undefined ? ` TS${d.code}` : ''}: ${d.message.replace(/\s*\n\s*/g, ' ')}`);
        }
      }
      for (const m of missing) lines.push(`${m}: file not found`);
      const header = `Checked ${files.length} file(s) with TypeScript ${TS_VERSION}: ${errors} error(s), ${warnings} warning(s).`;
      return text([header, ...lines, ...(shown > MAX_ITEMS ? [`… ${shown - MAX_ITEMS} more`] : [])].join('\n'));
    },
    async ts_hover(args) {
      const { w, uri, pos } = position(args);
      const r = await w.mgr.request('textDocument/hover', { textDocument: { uri }, position: pos });
      if (r.error) return fail(r.error.message);
      const c = r.result?.contents;
      const s = !c ? '' : typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (typeof x === 'string' ? x : x.value)).join('\n') : c.value;
      return text(s || 'No hover information at this position.');
    },
    async ts_definition(args) {
      const { w, uri, pos } = position(args);
      const r = await w.mgr.request('textDocument/definition', { textDocument: { uri }, position: pos });
      if (r.error) return fail(r.error.message);
      const locs = locations(r.result);
      return text(locs.length ? formatLocations(locs, w.root) : 'No definition found.');
    },
    async ts_references(args) {
      const { w, uri, pos } = position(args);
      const r = await w.mgr.request('textDocument/references', { textDocument: { uri }, position: pos, context: { includeDeclaration: true } });
      if (r.error) return fail(r.error.message);
      const locs = locations(r.result);
      return text(locs.length ? `${locs.length} reference(s):\n${formatLocations(locs, w.root)}` : 'No references found.');
    },
    async ts_symbols(args) {
      const root = args.file ? rootFor(absPath(args.file)) : defaultRoot();
      const w = workspace(root);
      if (args.file) sync(absPath(args.file));
      else if (!w.mgr.docs.size) {
        // tsgo needs at least one open file to load a project; open the first changed or any TS file
        const seed = changedFiles(root)[0] ?? findAnyTsFile(root);
        if (seed) sync(seed);
      }
      const r = await w.mgr.request('workspace/symbol', { query: args.query });
      if (r.error) return fail(r.error.message);
      const syms = (r.result ?? []).filter(s => s.location?.range);
      if (!syms.length) return text(`No symbols matching "${args.query}".`);
      return text(syms.slice(0, MAX_ITEMS).map(s => `${SYMBOL_KIND[s.kind] ?? 'symbol'} ${s.containerName ? s.containerName + '.' : ''}${s.name}  ${formatLocations([s.location], w.root)}`).join('\n'));
    },
  };
  function findAnyTsFile(root) {
    const stack = [root];
    while (stack.length) {
      const d = stack.pop();
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) return p;
      }
    }
    return null;
  }

  // ---------- protocol ----------
  async function onRequest(msg) {
    const { id, method, params } = msg;
    const reply = result => send({ jsonrpc: '2.0', id, result });
    const error = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize':
        clientCaps = params?.capabilities ?? {};
        return reply({
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'tsgo-bridge', version: VERSION },
          instructions: `TypeScript ${TS_VERSION} (tsgo) code intelligence. After editing TypeScript/JavaScript files call ts_diagnostics; use ts_definition / ts_references instead of text search for symbols.`,
        });
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call': {
        const h = handlers[params?.name];
        if (!h) return error(-32602, `unknown tool: ${params?.name}`);
        try { return reply(await h(params.arguments ?? {})); } catch (e) { log('tool error', params.name, e.stack); return reply(fail(`${params.name} failed: ${e.message}`)); }
      }
      default: return error(-32601, `method not found: ${method}`);
    }
  }
  function requestRoots() {
    if (!clientCaps.roots) return;
    const id = `roots-${++seq}`;
    pendingClient.set(id, r => {
      const list = r.result?.roots ?? [];
      roots = list.map(x => { try { return fileURLToPath(x.uri); } catch { return null; } }).filter(Boolean);
      log('roots', roots);
    });
    send({ jsonrpc: '2.0', id, method: 'roots/list' });
  }

  readNdjson(stdin, msg => {
    if (isRequest(msg)) onRequest(msg);
    else if (isResponse(msg)) { const cb = pendingClient.get(msg.id); pendingClient.delete(msg.id); cb?.(msg); }
    else if (isNotification(msg)) {
      if (msg.method === 'notifications/initialized') requestRoots();
      else if (msg.method === 'notifications/roots/list_changed') requestRoots();
    }
  }, e => log('framing', e.message));
  const finish = async () => { for (const { mgr } of managers.values()) await mgr.close(); exit(0); };
  stdin.on('end', finish);
  stdin.on('error', finish);
  log('mcp server started', { cwd, idleMs, node: process.version, platform: `${process.platform}-${process.arch}` });
}
