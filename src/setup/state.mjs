// Remembers what setup changed so uninstall can restore it.
import fs from 'node:fs';
import path from 'node:path';
import { userDataDir } from '../paths.mjs';

const file = () => path.join(userDataDir(), 'state.json');

export function loadState() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return { claude: {}, codex: {} }; }
}
export function saveState(s) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(s, null, 2));
}
