// Optional file logger. Enabled with TSGO_BRIDGE_LOG=<file>. Rotates at 5 MB (keeps one .1 file).
import fs from 'node:fs';
import path from 'node:path';

const MAX = 5 * 1024 * 1024;

export function createLogger(file = process.env.TSGO_BRIDGE_LOG, tag = 'tsgo-bridge') {
  if (!file) return Object.assign(() => {}, { enabled: false });
  const t0 = Date.now();
  let size = 0;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch {}
  try { size = fs.statSync(file).size; } catch {}
  const log = (...parts) => {
    const line = `${new Date().toISOString()} +${Date.now() - t0}ms [${tag}:${process.pid}] ${parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
    try {
      if (size + line.length > MAX) { try { fs.renameSync(file, file + '.1'); } catch {} size = 0; }
      fs.appendFileSync(file, line);
      size += line.length;
    } catch {}
  };
  log.enabled = true;
  return log;
}
