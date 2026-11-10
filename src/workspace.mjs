// Which workspace a file belongs to. One git repository or worktree = one workspace. Workspaces are
// independent copies of code: closing the documents of one never changes diagnostics or references in another.
// Each workspace has its own tsconfig projects and usually its own node_modules, so tsgo loads a separate set
// of projects (often more than 1 GB) per workspace.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Path key for comparisons: macOS and Windows file systems are case-insensitive by default. */
export const norm = p => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);

/** Nearest ancestor of `dir` that contains `.git` (a directory, or a file for worktrees and submodules). */
export function gitRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

/** Workspace key of a document URI: its normalized git root. Files outside git (and non-file URIs) share ''. */
export function workspaceOf(uri) {
  let file;
  try { file = fileURLToPath(uri); } catch { return ''; }
  const root = gitRoot(path.dirname(file));
  return root ? norm(root) : '';
}
