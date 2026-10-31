// Run an agent CLI (claude / codex) portably: try without a shell first (finds .exe), fall back to a shell (.cmd shims).
import { spawnSync } from 'node:child_process';
import os from 'node:os';

// Default cwd is the home directory: on Windows the cwd is searched for executables before PATH,
// so never resolve `claude` / `codex` from an arbitrary (possibly untrusted) project directory.
export function run(cmd, args, { env = process.env, cwd = os.homedir(), input } = {}) {
  const opts = { env, cwd, input, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
  let r = spawnSync(cmd, args, opts);
  if (r.error?.code === 'ENOENT' && process.platform === 'win32') {
    // .cmd shims (npm-installed CLIs) need cmd.exe; pass one pre-quoted command line
    const quote = a => (/[\s"&|<>^%]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
    r = spawnSync([cmd, ...args].map(quote).join(' '), { ...opts, shell: true });
  }
  return { ok: r.status === 0, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error, cmdline: [cmd, ...args].join(' ') };
}

export function has(cmd) {
  const r = run(cmd, ['--version']);
  return r.ok ? r.stdout.trim().split('\n')[0] : null;
}

/** env with one variable set (or removed when value is null) */
export function withEnv(key, value) {
  const env = { ...process.env };
  if (value === null) delete env[key]; else env[key] = value;
  return env;
}
