// Locate (and if needed install) the native TypeScript 7 executable for this OS/arch.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { PKG_ROOT, TS_VERSION, runtimeDir } from './paths.mjs';

const exeName = process.platform === 'win32' ? 'tsc.exe' : 'tsc';
const platformPkg = `@typescript/typescript-${process.platform}-${process.arch}`;

/** Given a directory that should contain node_modules/typescript, return the native exe or null. */
function nativeFrom(baseDir) {
  try {
    const req = createRequire(path.join(baseDir, 'noop.js'));
    const tsPkgJson = req.resolve('typescript/package.json');
    const tsPkg = JSON.parse(fs.readFileSync(tsPkgJson, 'utf8'));
    const platJson = createRequire(tsPkgJson).resolve(`${platformPkg}/package.json`);
    const exe = path.join(path.dirname(platJson), 'lib', exeName);
    if (fs.existsSync(exe)) return { command: exe, args: [], version: tsPkg.version, source: path.dirname(tsPkgJson) };
  } catch {}
  return null;
}

function npmCommand() {
  const dir = path.dirname(process.execPath);
  const candidates = process.platform === 'win32'
    ? [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    : [path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const c of candidates) if (fs.existsSync(c)) return { command: process.execPath, args: [c], shell: false };
  return { command: 'npm', args: [], shell: process.platform === 'win32' };
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Install typescript@TS_VERSION into dir (idempotent, guarded by a lock file for concurrent sessions). */
export function installRuntime(dir = runtimeDir(), log = () => {}) {
  if (nativeFrom(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.install.lock');
  const deadline = Date.now() + 180_000;
  for (;;) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; } catch {
      // someone else is installing; wait, then re-check. Steal a stale lock (> 3 min).
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 180_000) { fs.rmSync(lock, { force: true }); continue; } } catch {}
      if (nativeFrom(dir)) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for another TypeScript install in ${dir}`);
      sleep(500);
    }
  }
  try {
    if (nativeFrom(dir)) return;
    const npm = npmCommand();
    const args = [...npm.args, 'install', '--prefix', dir, '--no-audit', '--no-fund', '--omit=dev', '--no-package-lock', '--loglevel=error', `typescript@${TS_VERSION}`];
    log('installing', `typescript@${TS_VERSION}`, 'into', dir);
    const r = spawnSync(npm.command, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: npm.shell, windowsHide: true });
    if (r.status !== 0) throw new Error(`npm install typescript@${TS_VERSION} failed (${r.status}): ${(r.stderr || r.stdout || r.error?.message || '').slice(0, 2000)}`);
    if (!nativeFrom(dir)) throw new Error(`typescript@${TS_VERSION} installed but ${platformPkg} is missing — is ${process.platform}-${process.arch} supported?`);
  } finally { fs.rmSync(lock, { force: true }); }
}

/**
 * Resolve the tsgo launch command. Order:
 *   1. TSGO_TSC (path to a native tsc/tsgo binary, or to a .js launcher)
 *   2. typescript installed next to this package (dev checkout, Codex runtime install)
 *   3. the runtime dir (Claude plugin data dir / user data dir), installing it when `install` is true
 */
export function resolveTsgo({ install = true, log = () => {} } = {}) {
  const override = process.env.TSGO_TSC;
  if (override) {
    if (/\.(c|m)?js$/i.test(override)) return { command: process.execPath, args: [override], version: 'custom', source: override };
    return { command: override, args: [], version: 'custom', source: override };
  }
  const local = nativeFrom(PKG_ROOT);
  if (local && local.version === TS_VERSION) return local;
  const dir = runtimeDir();
  let rt = nativeFrom(dir);
  if (!rt && install) { installRuntime(dir, log); rt = nativeFrom(dir); }
  if (rt) return rt;
  if (local) return local; // version mismatch but usable
  throw new Error(`TypeScript ${TS_VERSION} native binary not found (looked in ${PKG_ROOT} and ${dir}). Run: tsgo-bridge doctor`);
}
