// Stand-in for `tsc --lsp --stdio`, for tests that must see exactly what tsgo receives.
//   FAKE_TSGO_LOG=<file>      one JSON line per received message: { t, method, uri, version, text, inFlight }
//   FAKE_DIAG_DELAY_MS=<n>    answer textDocument/diagnostic after n ms (default 0) with one item whose message is the
//                             document's text when the request arrived; $/cancelRequest answers at once
//   FAKE_DIAG_HANG=<text>     never answer diagnostics (not even when cancelled) for URIs that contain <text>
import fs from 'node:fs';
import { readLsp, frameLsp } from '../src/jsonrpc.mjs';

const logFile = process.env.FAKE_TSGO_LOG;
const delay = Number(process.env.FAKE_DIAG_DELAY_MS ?? 0);
const hang = process.env.FAKE_DIAG_HANG;
const inFlight = new Map(); // request id -> { timer, uri }
const texts = new Map(); // uri -> current full text (full-text changes only)
const record = o => { if (logFile) fs.appendFileSync(logFile, JSON.stringify({ t: Date.now(), ...o }) + '\n'); };
const send = msg => process.stdout.write(frameLsp({ jsonrpc: '2.0', ...msg }));

readLsp(process.stdin, m => {
  if (typeof m.method !== 'string') return; // responses to our (none) requests
  const td = m.params?.textDocument;
  if (m.method === 'textDocument/diagnostic') {
    const uri = td?.uri;
    record({ method: m.method, uri, inFlight: inFlight.size + 1, inFlightForUri: [...inFlight.values()].filter(x => x.uri === uri).length + 1 });
    if (hang && uri?.includes(hang)) { inFlight.set(m.id, { timer: null, uri }); return; }
    const items = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: texts.get(uri) ?? '' }];
    inFlight.set(m.id, { uri, timer: setTimeout(() => { inFlight.delete(m.id); send({ id: m.id, result: { kind: 'full', items } }); }, delay) });
    return;
  }
  if (m.method === '$/cancelRequest') {
    record({ method: m.method, id: m.params?.id });
    const f = inFlight.get(m.params?.id);
    if (f?.timer) { clearTimeout(f.timer); inFlight.delete(m.params.id); send({ id: m.params.id, error: { code: -32800, message: 'cancelled' } }); }
    return;
  }
  if (m.method === 'textDocument/didOpen') texts.set(td.uri, td.text);
  if (m.method === 'textDocument/didChange') for (const c of m.params.contentChanges) if (!c.range) texts.set(td.uri, c.text);
  record({ method: m.method, uri: td?.uri, version: td?.version, text: td?.text });
  if (m.method === 'initialize') send({ id: m.id, result: { capabilities: { hoverProvider: true }, serverInfo: { name: 'fake-tsgo', version: '0' } } });
  else if (m.method === 'exit') process.exit(0);
  else if (m.id !== undefined && m.id !== null) send({ id: m.id, result: null });
});
process.stdin.on('end', () => process.exit(0));
