// JSON-RPC framing helpers.
//  - LSP uses `Content-Length: N\r\n\r\n<body>` framing.
//  - MCP stdio uses newline-delimited JSON.

/** Read Content-Length framed messages from a stream. */
export function readLsp(stream, onMessage, onError = () => {}) {
  let buf = Buffer.alloc(0);
  stream.on('data', chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
    for (;;) {
      const sep = buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const header = buf.subarray(0, sep).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { buf = buf.subarray(sep + 4); onError(new Error(`bad header: ${header}`)); continue; }
      const len = Number(m[1]);
      if (buf.length < sep + 4 + len) return;
      const body = buf.subarray(sep + 4, sep + 4 + len);
      buf = buf.subarray(sep + 4 + len);
      let msg;
      try { msg = JSON.parse(body.toString('utf8')); } catch (e) { onError(e); continue; }
      onMessage(msg);
    }
  });
}

/** Encode one message with Content-Length framing. */
export function frameLsp(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/** Read newline-delimited JSON messages from a stream. */
export function readNdjson(stream, onMessage, onError = () => {}) {
  let buf = '';
  stream.setEncoding?.('utf8');
  stream.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { onError(e); continue; }
      onMessage(msg);
    }
  });
}

export const frameNdjson = msg => JSON.stringify(msg) + '\n';

export const isRequest = m => m && typeof m.method === 'string' && m.id !== undefined && m.id !== null;
export const isNotification = m => m && typeof m.method === 'string' && (m.id === undefined || m.id === null);
export const isResponse = m => m && m.method === undefined && m.id !== undefined;
