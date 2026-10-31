// Minimal scriptable LSP and MCP clients over a child process. Used by `doctor` and the test suite.
import { spawn } from 'node:child_process';
import { readLsp, frameLsp, readNdjson, frameNdjson, isResponse, isRequest } from './jsonrpc.mjs';

export function lspClient(command, args, { cwd, env } = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = ''; child.stderr.on('data', d => { stderr += d; });
  let id = 0; const pending = new Map(); const diags = new Map(); const notifications = [];
  const norm = u => decodeURIComponent(u).toLowerCase();
  readLsp(child.stdout, m => {
    if (isResponse(m)) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
    if (isRequest(m)) { child.stdin.write(frameLsp({ jsonrpc: '2.0', id: m.id, result: null })); return; }
    notifications.push({ t: Date.now(), m });
    if (m.method === 'textDocument/publishDiagnostics') diags.set(norm(m.params.uri), { t: Date.now(), items: m.params.diagnostics });
  });
  const request = (method, params, timeout = 60_000) => new Promise(res => {
    const i = ++id; const t = setTimeout(() => { pending.delete(i); res({ timeout: true }); }, timeout);
    pending.set(i, m => { clearTimeout(t); res(m); });
    child.stdin.write(frameLsp({ jsonrpc: '2.0', id: i, method, params }));
  });
  const notify = (method, params) => child.stdin.write(frameLsp({ jsonrpc: '2.0', method, params }));
  async function waitDiagnostics(uri, since, pred = () => true, timeout = 30_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const e = diags.get(norm(uri));
      if (e && e.t >= since && pred(e.items)) return { ms: e.t - since, items: e.items };
      await new Promise(r => setTimeout(r, 20));
    }
    return { timeout: true, items: diags.get(norm(uri))?.items };
  }
  const exited = new Promise(r => child.on('exit', code => r(code)));
  return { child, request, notify, waitDiagnostics, notifications, exited, get stderr() { return stderr; } };
}

/** Capabilities exactly as Claude Code 2.1.316 sends them (recorded). */
export const CLAUDE_CODE_CAPABILITIES = {
  workspace: { configuration: false, workspaceFolders: false, didChangeWatchedFiles: { dynamicRegistration: false } },
  textDocument: {
    synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: true },
    publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] }, versionSupport: false, codeDescriptionSupport: true, dataSupport: false },
    hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
    definition: { dynamicRegistration: false, linkSupport: true },
    references: { dynamicRegistration: false },
    documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
    callHierarchy: { dynamicRegistration: false },
  },
  general: { positionEncodings: ['utf-16'] },
};

export function mcpClient(command, args, { cwd, env } = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = ''; child.stderr.on('data', d => { stderr += d; });
  let id = 0; const pending = new Map();
  readNdjson(child.stdout, m => { if (isResponse(m)) { pending.get(m.id)?.(m); pending.delete(m.id); } });
  const request = (method, params, timeout = 60_000) => new Promise(res => {
    const i = ++id; const t = setTimeout(() => { pending.delete(i); res({ timeout: true }); }, timeout);
    pending.set(i, m => { clearTimeout(t); res(m); });
    child.stdin.write(frameNdjson({ jsonrpc: '2.0', id: i, method, params }));
  });
  const notify = (method, params) => child.stdin.write(frameNdjson({ jsonrpc: '2.0', method, params }));
  const call = async (name, args, timeout) => { const r = await request('tools/call', { name, arguments: args }, timeout); return r.result?.content?.map(c => c.text).join('\n') ?? JSON.stringify(r.error ?? r); };
  const exited = new Promise(r => child.on('exit', code => r(code)));
  return { child, request, notify, call, exited, get stderr() { return stderr; } };
}
