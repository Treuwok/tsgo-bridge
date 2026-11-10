// TsgoManager: owns one `tsc --lsp --stdio` (TypeScript 7 native) process for one workspace.
//  - lazy start, idle stop, transparent restart with replay of open documents
//  - crash handling: read-only requests are retried once on a fresh server, others fail fast
//  - answers server->client requests itself (registerCapability, configuration, refresh, progress)
//  - working set: documents of workspaces unused for workspaceIdleMs are parked (see #parkIdle)
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { readLsp, frameLsp, isRequest, isResponse } from './jsonrpc.mjs';
import { applyContentChanges } from './text.mjs';
import { workspaceOf } from './workspace.mjs';

export const RETRYABLE = new Set([
  'textDocument/hover', 'textDocument/definition', 'textDocument/typeDefinition', 'textDocument/declaration',
  'textDocument/implementation', 'textDocument/references', 'textDocument/documentSymbol', 'workspace/symbol',
  'textDocument/prepareCallHierarchy', 'callHierarchy/incomingCalls', 'callHierarchy/outgoingCalls',
  'textDocument/documentHighlight', 'textDocument/signatureHelp', 'textDocument/diagnostic', 'textDocument/foldingRange',
  'textDocument/selectionRange', 'textDocument/semanticTokens/full', 'textDocument/inlayHint', 'textDocument/codeLens',
]);

/** Document a request is about: `textDocument.uri`, or `item.uri` for callHierarchy/incomingCalls|outgoingCalls. */
export const docUri = params => params?.textDocument?.uri ?? params?.item?.uri;

/** Throwaway document: opening it makes tsgo remove projects that have no open document (see #checkIdle). */
const RELEASE_URI = 'untitled:tsgo-bridge-release';

export class TsgoManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => {command:string,args:string[]}} o.resolveCommand  resolved lazily on (re)start
   * @param {object} o.initParams     initialize params to send (already adapted by the frontend)
   * @param {number} [o.idleMs]       0 disables idle stop
   * @param {number} [o.workspaceIdleMs] park the documents of a workspace (git root) that was not used for this
   *                                   long; they come back when used (0 = never)
   * @param {number} [o.maxDocs]      most open documents; older ones are closed and forgotten (0 = no limit)
   * @param {Function} [o.log]
   * @param {object} [o.env]
   */
  constructor({ resolveCommand, initParams, idleMs = 600_000, workspaceIdleMs = 0, maxDocs = 0, log = () => {}, env = process.env }) {
    super();
    this.resolveCommand = resolveCommand;
    this.initParams = initParams;
    this.idleMs = idleMs;
    this.workspaceIdleMs = workspaceIdleMs;
    this.maxDocs = maxDocs > 0 ? maxDocs : Infinity;
    this.log = log;
    this.env = env;
    this.state = 'idle'; // idle | starting | ready | stopping | closed
    this.proc = null;
    this.docs = new Map(); // uri -> { languageId, version, text, workspace }; order: least -> most recently used
    this.parked = new Map(); // same shape: closed in tsgo because their workspace is idle, still open for the client
    this.lastUse = new Map(); // workspace -> time it was last used (opened, edited or queried)
    this.pending = new Map(); // server request id -> { method, params, resolve, retryable, retried }
    this.queue = []; // { kind:'request'|'notify', ... } waiting for ready
    this.seq = 0;
    this.starts = 0;
    this.initResult = null;
    this.lastActivity = Date.now();
    this.readyWaiters = [];
    const tick = Math.min(...[idleMs, workspaceIdleMs].filter(ms => ms > 0));
    if (Number.isFinite(tick)) {
      this.idleTimer = setInterval(() => this.#checkIdle(), Math.max(200, Math.min(tick / 4, 30_000)));
      this.idleTimer.unref();
    }
  }

  // ---------------- public API ----------------
  touch() { this.lastActivity = Date.now(); }

  /** Start (if needed) and resolve once ready. Returns the initialize result of the first start. */
  ready() {
    this.touch();
    if (this.state === 'ready') return Promise.resolve(this.initResult);
    if (this.state === 'closed') return Promise.reject(new Error('manager closed'));
    const p = new Promise((res, rej) => this.readyWaiters.push({ res, rej }));
    if (this.state === 'idle') this.#start();
    return p;
  }

  /** Send a request; resolves with the raw response message ({result} or {error}). Never rejects. */
  request(method, params, { retryable = RETRYABLE.has(method), onSent } = {}) {
    this.touch();
    if (this.state === 'closed') return Promise.resolve({ error: { code: -32800, message: 'closed' } });
    const uri = docUri(params);
    if (uri) this.#revive(uri); // a request on a parked document must not reload its project behind the limit
    return new Promise(resolve => {
      const item = { method, params, resolve, retryable, retried: false, onSent };
      if (this.state === 'ready') this.#sendRequest(item);
      else { this.queue.push({ kind: 'request', item }); this.#ensureStarted(); }
    });
  }

  /** Cancel a request previously issued with request(); the response still resolves (usually with an error). */
  cancel(serverId) { if (this.state === 'ready' && this.pending.has(serverId)) this.#write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: serverId } }); }

  notify(method, params) {
    this.touch();
    if (this.state === 'ready') this.#write({ jsonrpc: '2.0', method, params });
    else { this.queue.push({ kind: 'notify', method, params }); this.#ensureStarted(); }
  }

  openDoc(uri, languageId, version, text) {
    this.touch();
    const workspace = workspaceOf(uri);
    this.parked.delete(uri);
    this.docs.delete(uri);
    this.#activate(workspace, 1);
    this.#open(uri, { languageId, version, text, workspace });
  }

  /** Open for the client: open in tsgo, or parked by the working-set limit. */
  isOpen(uri) { return this.docs.has(uri) || this.parked.has(uri); }

  /** Mark an open document (and its workspace) as used now; the frontend decides what counts as use. */
  markUsed(uri) {
    const d = this.docs.get(uri);
    if (!d) return;
    this.docs.delete(uri);
    this.docs.set(uri, d);
    this.lastUse.set(d.workspace, Date.now());
  }

  changeDoc(uri, version, contentChanges) {
    this.touch();
    this.#revive(uri);
    const d = this.docs.get(uri);
    if (!d) return false;
    d.text = applyContentChanges(d.text, contentChanges);
    d.version = version;
    if (this.state === 'ready') this.#write({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri, version }, contentChanges } });
    else this.#ensureStarted();
    return true;
  }

  saveDoc(uri, text) {
    this.touch();
    if (!this.docs.has(uri)) return;
    if (this.state === 'ready') this.#write({ jsonrpc: '2.0', method: 'textDocument/didSave', params: text === undefined ? { textDocument: { uri } } : { textDocument: { uri }, text } });
  }

  closeDoc(uri) {
    this.touch();
    this.#close(uri);
  }

  /** Pull diagnostics for an open document. Returns items[] or null. */
  async pullDiagnostics(uri) {
    const r = await this.request('textDocument/diagnostic', { textDocument: { uri } });
    if (r.error || !r.result) return null;
    if (r.result.kind === 'full') return r.result.items ?? [];
    return null; // 'unchanged' (we never send previousResultId, so this should not happen)
  }

  get pid() { return this.proc?.pid ?? null; }

  /** Graceful shutdown of the server (client is going away). */
  async close() {
    clearInterval(this.idleTimer);
    const was = this.state;
    this.state = 'closed';
    for (const w of this.readyWaiters.splice(0)) w.rej(new Error('closed'));
    for (const q of this.queue.splice(0)) if (q.kind === 'request') q.item.resolve({ error: { code: -32800, message: 'closed' } });
    if (this.proc && (was === 'ready' || was === 'starting' || was === 'stopping')) await this.#stopProcess(this.proc, 3000);
  }

  // ---------------- internals ----------------
  /**
   * `workspace` is used now, for `incoming` new documents: keep at most maxDocs documents, and re-open the parked
   * documents of `workspace` (the client still has them open; cross-file diagnostics and references need them).
   */
  #activate(workspace, incoming = 0) {
    this.lastUse.set(workspace, Date.now());
    const back = [...this.parked].filter(([, d]) => d.workspace === workspace);
    let kept = incoming + back.length;
    const close = [];
    for (const [uri] of [...this.docs].reverse()) if (kept < this.maxDocs) kept++; else close.push(uri); // newest first
    if (close.length) this.log('closing', close.length, 'least recently used docs');
    for (const uri of close) this.#close(uri);
    for (const [uri, d] of back) { this.parked.delete(uri); this.#open(uri, d); }
    if (back.length) this.emit('reopen', back.map(([uri]) => uri));
  }

  /**
   * Park the documents of every workspace not used for workspaceIdleMs; returns how many. Claude Code never sends
   * didClose, and tsgo keeps every project that has an open document, so without this every git worktree an agent ever
   * edited stays loaded (more than 1 GB each for a large app). Workspaces in use are never parked: a count limit made
   * concurrently used worktrees evict each other and reload on every edit (measured). Parked documents keep their text.
   */
  #parkIdle() {
    if (!(this.workspaceIdleMs > 0)) return 0;
    const cutoff = Date.now() - this.workspaceIdleMs;
    const idle = [...this.docs].filter(([, d]) => (this.lastUse.get(d.workspace) ?? 0) < cutoff);
    if (!idle.length) return 0;
    this.log('parking', idle.length, 'docs of idle workspaces', [...new Set(idle.map(([, d]) => d.workspace))]);
    for (const [uri, d] of idle) { this.#close(uri); this.parked.set(uri, d); }
    return idle.length;
  }

  /** A parked document is used again: bring its workspace back. */
  #revive(uri) {
    const p = this.parked.get(uri);
    if (p) this.#activate(p.workspace);
  }

  /** Close without recording activity: the bridge closing documents itself must not postpone the idle stop. */
  #close(uri) {
    this.parked.delete(uri);
    if (!this.docs.delete(uri)) return;
    if (this.state === 'ready') this.#write({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } });
  }

  #open(uri, d) {
    this.docs.set(uri, d);
    if (this.state === 'ready') this.#write({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: d.languageId, version: d.version, text: d.text } } });
    else this.#ensureStarted();
  }

  #write(msg) { try { this.proc.stdin.write(frameLsp(msg)); } catch (e) { this.log('write failed', e.message); } }

  #sendRequest(item) {
    const id = `tsgo-bridge-${++this.seq}`;
    item.id = id;
    this.pending.set(id, item);
    this.#write({ jsonrpc: '2.0', id, method: item.method, params: item.params });
    item.onSent?.(id);
  }

  #ensureStarted() {
    if (this.state === 'idle') this.#start();
    else if (this.state === 'stopping') this.startAfterStop = true; // a document changed while the server was stopping
  }

  #start() {
    this.state = 'starting';
    this.starts++;
    let cmd;
    try { cmd = this.resolveCommand(); } catch (e) { this.#failStart(e); return; }
    this.log('start #' + this.starts, cmd.command, cmd.args.join(' '), 'docs', this.docs.size, 'queued', this.queue.length);
    const proc = spawn(cmd.command, [...cmd.args, '--lsp', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'], env: this.env, windowsHide: true });
    this.proc = proc;
    proc.on('error', e => { this.log('spawn error', e.message); if (this.proc === proc) this.#onExit(proc, null, null, e); });
    proc.on('exit', (code, sig) => this.#onExit(proc, code, sig));
    proc.stdin.on('error', e => this.log('server stdin error', e.message));
    proc.stderr.on('data', d => this.log('server stderr:', d.toString().trim().slice(0, 500)));
    readLsp(proc.stdout, msg => { if (this.proc === proc) this.#onServerMessage(msg); }, e => this.log('server framing', e.message));
    this.emit('spawn', proc.pid);
    this.log('server pid', proc.pid);

    const id = `tsgo-bridge-init-${this.starts}`;
    this.pending.set(id, {
      method: 'initialize', retryable: false, resolve: resp => {
        if (this.proc !== proc) return;
        if (resp.error) { this.#failStart(new Error(`initialize failed: ${resp.error.message}`)); return; }
        if (!this.initResult) this.initResult = resp.result;
        this.#write({ jsonrpc: '2.0', method: 'initialized', params: {} });
        for (const [uri, d] of this.docs) this.#write({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: d.languageId, version: d.version, text: d.text } } });
        this.state = 'ready';
        this.log('ready; replayed', this.docs.size, 'docs; flushing', this.queue.length);
        for (const q of this.queue.splice(0)) {
          if (q.kind === 'request') this.#sendRequest(q.item);
          else this.#write({ jsonrpc: '2.0', method: q.method, params: q.params });
        }
        for (const w of this.readyWaiters.splice(0)) w.res(this.initResult);
        this.emit('ready', { restart: this.starts > 1, docs: this.docs.size });
      },
    });
    this.#write({ jsonrpc: '2.0', id, method: 'initialize', params: { ...this.initParams, processId: process.pid } });
  }

  #failStart(err) {
    this.log('start failed:', err.message);
    this.state = 'idle';
    for (const w of this.readyWaiters.splice(0)) w.rej(err);
    for (const q of this.queue.splice(0)) if (q.kind === 'request') q.item.resolve({ error: { code: -32803, message: `TypeScript server failed to start: ${err.message}` } });
    this.emit('start-failed', err);
  }

  #onServerMessage(msg) {
    if (isResponse(msg)) {
      const item = this.pending.get(msg.id);
      if (!item) return;
      this.pending.delete(msg.id);
      item.resolve(msg);
      return;
    }
    if (isRequest(msg)) {
      let result = null;
      if (msg.method === 'workspace/configuration') result = (msg.params?.items ?? []).map(() => null);
      if (msg.method === 'workspace/diagnostic/refresh') this.emit('refresh');
      // registerCapability / unregisterCapability / workDoneProgress/create / semanticTokens/refresh / others: acknowledge
      this.#write({ jsonrpc: '2.0', id: msg.id, result });
      return;
    }
    this.emit('notification', msg);
  }

  #onExit(proc, code, sig, err) {
    if (this.proc !== proc) return;
    const was = this.state;
    this.proc = null;
    this.log('server exit', { code, sig, was, pending: this.pending.size, err: err?.message });
    if (this.state !== 'closed') this.state = 'idle';
    const retry = [];
    for (const [, item] of this.pending) {
      if (item.method === 'initialize' || item.method === 'shutdown') { item.resolve({ error: { code: -32803, message: 'server exited' } }); continue; }
      if (item.retryable && !item.retried && this.state !== 'closed') { item.retried = true; retry.push(item); continue; }
      item.resolve({ error: { code: -32803, message: `TypeScript server ${was === 'stopping' ? 'stopped' : 'exited unexpectedly'} while handling ${item.method}; please retry` } });
    }
    this.pending.clear();
    if (was === 'starting') this.#failStart(err ?? new Error(`server exited during startup (code ${code})`));
    this.emit('exit', { code, sig, expected: was === 'stopping' || was === 'closed' });
    if (this.state === 'closed') return;
    if (retry.length) this.queue.unshift(...retry.map(item => ({ kind: 'request', item })));
    // work that arrived while stopping (or retries) needs a fresh server
    const wanted = this.startAfterStop;
    this.startAfterStop = false;
    if (this.queue.length || this.readyWaiters.length || wanted) this.#ensureStarted();
  }

  #checkIdle() {
    // tsgo removes projects without open documents only while it handles a didOpen, so a throwaway didOpen follows
    // (verified: it leaves the projects that still have open documents alone); caches are freed after 30 s quiet.
    if (this.state === 'ready' && this.#parkIdle() > 0) {
      this.#write({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: RELEASE_URI, languageId: 'typescript', version: 1, text: '' } } });
      this.#write({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri: RELEASE_URI } } });
    }
    if (!(this.idleMs > 0) || this.state !== 'ready' || this.pending.size > 0) return; // idleMs 0: never stop
    if (Date.now() - this.lastActivity < this.idleMs) return;
    this.log('idle for', Date.now() - this.lastActivity, 'ms; stopping server');
    this.state = 'stopping';
    this.#stopProcess(this.proc, 5000);
    this.emit('idle-stop');
  }

  /** shutdown -> exit -> kill after timeout. */
  #stopProcess(proc, timeoutMs) {
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
      proc.once('exit', finish);
      const t = setTimeout(() => { try { proc.kill(); } catch {} setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} finish(); }, 2000).unref(); }, timeoutMs);
      t.unref();
      const id = `tsgo-bridge-shutdown-${++this.seq}`;
      this.pending.set(id, { method: 'shutdown', retryable: false, resolve: () => { try { proc.stdin.write(frameLsp({ jsonrpc: '2.0', method: 'exit' })); proc.stdin.end(); } catch {} } });
      try { proc.stdin.write(frameLsp({ jsonrpc: '2.0', id, method: 'shutdown', params: null })); } catch { try { proc.kill(); } catch {} }
      if (proc.exitCode !== null) finish();
    });
  }
}
