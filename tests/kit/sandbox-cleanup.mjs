// Removes a test sandbox. A removal that fails throws an error that names what is still in the directory, with the type and
// modification time of each entry, and the live processes of the test's process group, so the cause of a race is in the
// report of its occurrence. The removal runs once: no retry and no force past an error.
import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const LISTED_LIMIT = 200;

/** Each entry below `directory` as `<relative path> <type> mtime <ISO time>`, at most LISTED_LIMIT entries. */
function entriesOf(directory, relative = '', out = []) {
  for (const name of readdirSync(path.join(directory, relative)).sort()) {
    if (out.length >= LISTED_LIMIT) return out;
    const next = path.join(relative, name);
    const stat = lstatSync(path.join(directory, next));
    const type = stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symbolic link' : 'file';
    out.push(`${next.split(path.sep).join('/')} ${type} mtime ${stat.mtime.toISOString()}`);
    if (stat.isDirectory()) entriesOf(directory, next, out);
  }
  return out;
}

/** The command lines of the live processes that share the process group of this process, from ps. */
function groupProcesses() {
  const group = spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim();
  const listed = spawnSync('ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8' }).stdout.split('\n');
  return listed.map(line => line.trim()).filter(line => line.split(/\s+/)[1] === group);
}

/**
 * Removes `directory` recursively. `remove` is the removal (rmSync by default). A failed removal throws an Error whose cause is
 * the original error and whose message names the error, each entry still in the directory and the live processes of the group.
 */
export function removeSandbox(directory, { remove = rmSync } = {}) {
  try {
    remove(directory, { recursive: true, force: true });
  } catch (error) {
    const still = entriesOf(directory);
    const processes = groupProcesses();
    throw new Error(
      `cannot remove ${directory} (${error.code}: ${error.message}); still in it: ${still.join('; ') || 'nothing listed'}; live processes of this process group: ${processes.join(' | ') || 'none'}`,
      { cause: error },
    );
  }
}
