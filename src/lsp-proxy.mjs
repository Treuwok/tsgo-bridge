// LSP frontend for push-only clients (Claude Code): stdio LSP in, TsgoManager out.
//  - initialize: advertise pull diagnostics to tsgo, hide diagnosticProvider from the client
//  - client `initialized` is swallowed (the manager sends its own on every (re)start; two of them panic tsgo)
//  - pull -> push: after open/change/save, pull diagnostics and publish them (deduplicated)
//  - at most one diagnostics pull per document at a time (each pull pins a tsgo snapshot until it is answered)
//  - a git root whose files were not edited or queried for TSGO_IDLE_MS is closed in tsgo (Claude Code never sends
//    didClose); its files come back when used
//  - client request ids are mapped to manager requests; $/cancelRequest is translated
import { readLsp, frameLsp, isRequest, isNotification } from './jsonrpc.mjs';
import { TsgoManager, docUri } from './tsgo-manager.mjs';
import { resolveTsgo } from './resolve-tsgo.mjs';
import { createLogger } from './log.mjs';

export function runLspProxy({ stdin = process.stdin, stdout = process.stdout, env = process.env, exit = code => process.exit(code) } = {}) {
  const log = createLogger(env.TSGO_BRIDGE_LOG, 'lsp');
  const idleMs = env.TSGO_IDLE_MS !== undefined ? Number(env.TSGO_IDLE_MS) : 600_000;
  const debounceMs = env.TSGO_DIAG_DEBOUNCE_MS !== undefined ? Number(env.TSGO_DIAG_DEBOUNCE_MS) : 50;
  const pullToPush = env.TSGO_PULL_TO_PUSH !== '0';
  const send = msg => { try { stdout.write(frameLsp(msg)); } catch (e) { log('client write failed', e.message); } };

  let mgr = null;
  let shuttingDown = false;
  const clientToServer = new Map(); // client request id -> manager request id (for cancellation)
  const published = new Map(); // uri -> JSON of last published diagnostics
  const dirty = new Set();
  let timer = null;
  const pulling = new Set(); // documents with a diagnostics pull in flight
  const again = new Set(); // documents to pull again when their pull in flight is answered

  function schedule(uris) {
    if (!pullToPush || !mgr) return;
    for (const u of uris) dirty.add(u);
    clearTimeout(timer);
    timer = setTimeout(flushDiagnostics, debounceMs);
  }
  function flushDiagnostics() {
    // touched documents first, then every other open document (cross-file errors)
    const order = [...new Set([...dirty, ...mgr.docs.keys()])];
    dirty.clear();
    for (const uri of order) pull(uri);
  }
  function pull(uri) {
    if (!mgr.docs.has(uri)) return;
    // One pull per document: overlapping pulls of fast edits each pinned their own tsgo snapshot (2026-11-10: 49 GB).
    if (pulling.has(uri)) { again.add(uri); return; }
    pulling.add(uri);
    mgr.pullDiagnostics(uri).then(items => {
      if (items !== null && mgr.docs.has(uri)) publish(uri, items);
    }).finally(() => {
      pulling.delete(uri);
      if (again.delete(uri)) pull(uri);
    });
  }
  function publish(uri, diagnostics) {
    const key = JSON.stringify(diagnostics);
    if (published.get(uri) === key) return;
    published.set(uri, key);
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
  }

  function createManager(params) {
    const initParams = structuredClone(params);
    if (pullToPush) {
      const td = (initParams.capabilities ??= {}).textDocument ??= {};
      td.diagnostic ??= { dynamicRegistration: false, relatedDocumentSupport: false };
    }
    // never advertise client-side file watching: tsgo then watches the file system itself (verified)
    if (initParams.capabilities?.workspace?.didChangeWatchedFiles) initParams.capabilities.workspace.didChangeWatchedFiles.dynamicRegistration = false;
    const m = new TsgoManager({ resolveCommand: () => resolveTsgo({ log }), initParams, idleMs, workspaceIdleMs: idleMs, log, env });
    m.on('notification', msg => {
      if (msg.method === 'textDocument/publishDiagnostics') { publish(msg.params.uri, msg.params.diagnostics); return; }
      if (msg.method === '$/progress' || msg.method === '$/typescriptVersion') return;
      send(msg);
    });
    m.on('ready', ({ restart }) => { if (restart) schedule([]); });
    m.on('reopen', uris => schedule(uris)); // a parked workspace is back
    m.on('refresh', () => schedule([]));
    m.on('idle-stop', () => log('idle stop'));
    return m;
  }

  async function onRequest(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
      mgr = createManager(params);
      try {
        const result = structuredClone(await mgr.ready());
        if (pullToPush && result?.capabilities) delete result.capabilities.diagnosticProvider;
        result.serverInfo = { name: 'tsgo-bridge', version: `${result.serverInfo?.name ?? 'tsgo'} ${result.serverInfo?.version ?? ''}`.trim() };
        send({ jsonrpc: '2.0', id, result });
      } catch (e) {
        send({ jsonrpc: '2.0', id, error: { code: -32603, message: `tsgo-bridge: ${e.message}` } });
      }
      return;
    }
    if (!mgr) { send({ jsonrpc: '2.0', id, error: { code: -32002, message: 'Server not initialized' } }); return; }
    if (method === 'shutdown') {
      shuttingDown = true;
      clearTimeout(timer);
      await mgr.close();
      send({ jsonrpc: '2.0', id, result: null });
      return;
    }
    if (docUri(params)) mgr.markUsed(docUri(params));
    // the manager id is assigned when the request is actually sent (immediately, or after a (re)start)
    const resp = await mgr.request(method, params, { onSent: sid => clientToServer.set(id, sid) });
    clientToServer.delete(id);
    send(resp.error ? { jsonrpc: '2.0', id, error: resp.error } : { jsonrpc: '2.0', id, result: resp.result ?? null });
  }

  function onNotification(msg) {
    const { method, params } = msg;
    switch (method) {
      case 'initialized': return; // swallowed on purpose
      case 'exit': finish(0); return;
      case '$/cancelRequest': { const sid = clientToServer.get(params?.id); if (sid && mgr) mgr.cancel(sid); return; }
      case 'textDocument/didOpen': { const t = params.textDocument; mgr?.openDoc(t.uri, t.languageId, t.version, t.text); schedule([t.uri]); return; }
      case 'textDocument/didChange': {
        const t = params.textDocument;
        if (mgr?.changeDoc(t.uri, t.version, params.contentChanges)) mgr.markUsed(t.uri); // re-opens a parked document
        schedule([t.uri]);
        return;
      }
      case 'textDocument/didSave': { mgr?.saveDoc(params.textDocument.uri, params.text); schedule([params.textDocument.uri]); return; }
      case 'textDocument/didClose': { mgr?.closeDoc(params.textDocument.uri); published.delete(params.textDocument.uri); return; }
      default: mgr?.notify(method, params);
    }
  }

  let finished = false;
  async function finish(code) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (mgr && !shuttingDown) await mgr.close();
    log('exit', code);
    exit(code);
  }

  readLsp(stdin, msg => {
    if (isRequest(msg)) onRequest(msg).catch(e => { log('request handler error', e.stack); send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } }); });
    else if (isNotification(msg)) { try { onNotification(msg); } catch (e) { log('notification handler error', e.stack); } }
    // responses from the client are ignored: the manager answers server->client requests itself
  }, e => log('client framing', e.message));
  stdin.on('end', () => finish(0));
  stdin.on('error', () => finish(0));
  stdout.on?.('error', () => finish(0));
  log('lsp proxy started', { idleMs, debounceMs, pullToPush, node: process.version, platform: `${process.platform}-${process.arch}` });
}
