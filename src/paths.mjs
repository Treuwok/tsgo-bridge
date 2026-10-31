// Cross-platform locations.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
export const VERSION = PKG.version;
export const TS_VERSION = PKG.tsgoBridge.typescriptVersion;

/** Per-user data directory for tsgo-bridge (runtime installs, state). */
export function userDataDir() {
  if (process.env.TSGO_BRIDGE_DATA) return process.env.TSGO_BRIDGE_DATA;
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'tsgo-bridge');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'tsgo-bridge');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'tsgo-bridge');
}

/** Directory where the TypeScript runtime gets installed when it is not bundled next to the package. */
export function runtimeDir() {
  // Inside Claude Code, CLAUDE_PLUGIN_DATA survives plugin updates and is removed on uninstall.
  const base = process.env.TSGO_BRIDGE_DATA || process.env.CLAUDE_PLUGIN_DATA || userDataDir();
  return path.join(base, `typescript-${TS_VERSION}`);
}

/** Orca keeps per-profile agent homes; return its base config dir for this OS. */
export function orcaBaseDir() {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'orca');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'orca');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'orca');
}
