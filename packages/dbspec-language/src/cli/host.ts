// The node:fs host of resolveSet (set.ts), which the command line passes. It examines without following a symbolic
// link, lists a POSIX directory by the bytes of its names and opens each file once, taking its bytes and its identity
// from that handle, as the set reader of @polyspec/orm does (docs/dbspec.md "Document sets", steps 1, 3 and 4).
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import type { SetHost, SetHostEntry } from '../set.js';

const WINDOWS = process.platform === 'win32';
// O_NOFOLLOW makes an open refuse a symbolic link that appeared after its examination; Windows has no such flag, and
// a reparse point there is judged by lstat before the open.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/** The host of resolveSet on the Node file system. */
export const nodeSetHost: SetHost = Object.freeze({
  lstat(path: string): SetHostEntry | null {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (thrown) {
      // No entry is there: the path or one of its directories does not exist, or a component is not a directory.
      const code = (thrown as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw thrown;
    }
    // Node reports a Windows reparse point whose tag is a symbolic link or a junction as a symbolic link.
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'directory';
    if (stat.isFile()) return 'file';
    return 'other';
  },
  list(directory: string): readonly (Uint8Array | string)[] {
    if (WINDOWS) return readdirSync(directory);
    return readdirSync(directory, { encoding: 'buffer' });
  },
  open(path: string): { readonly bytes: Uint8Array; readonly identity: string } {
    const fd = openSync(path, OPEN_FLAGS);
    try {
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile()) throw new Error('it is not a regular file');
      const bytes = readFileSync(fd);
      return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), identity: `${stat.dev}:${stat.ino}` };
    } finally {
      closeSync(fd);
    }
  },
});
