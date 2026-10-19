// The set reader (docs/spec/dbspec.md "Document sets"): readDbspecSet reads the set file dbspec-set.json and the files it
// lists, in the four steps of the specification, without following a symbolic link. The rules that read no file run
// through parseSet (set_file.ts). It is Node-only, so the browser entry (entry.ts) does not reach it.
import { present } from '../present.js';
import { inspect } from 'node:util';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import {
  parseSetOn,
  setError,
  setNameError,
  splitSetPath,
  type DbspecSetError,
  type DbspecSetPath,
} from './set_file.js';

/** A file of a document set: its joined path and its bytes. */
export interface DbspecSetFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * The result of readDbspecSet: the files of `documents` and of `external` in written order with no error, or the
 * errors, by step and then by path, and no files.
 */
export type DbspecSetResult =
  | { readonly documents: readonly DbspecSetFile[]; readonly external: readonly DbspecSetFile[]; readonly errors: readonly [] }
  | { readonly documents: null; readonly external: null; readonly errors: readonly DbspecSetError[] };

const WINDOWS = process.platform === 'win32';
// O_NOFOLLOW makes an open refuse a symbolic link that appeared after its examination; Windows has no such flag, and
// a reparse point there is judged by lstat before the open.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

function failure(errors: readonly DbspecSetError[]): DbspecSetResult {
  return Object.freeze({ documents: null, external: null, errors: Object.freeze([...errors]) });
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : inspect(error);
}

/**
 * The root of a set: the prefix without its trailing separators, so that lstat does not follow a symbolic link that
 * the root is, or `.` when the prefix is empty. A root of only separators stays as it is, and so does a Windows drive
 * root such as `C:\`.
 */
function rootOf(prefix: string): string {
  if (prefix === '') return '.';
  const trimmed = prefix.replace(WINDOWS ? /[/\\]+$/ : /\/+$/, '');
  if (trimmed === '') return prefix;
  if (WINDOWS && /^[A-Za-z]:$/.test(trimmed) && trimmed.length < prefix.length) return prefix;
  return trimmed;
}

/**
 * Whether the directory `directory` lists the name `name`: on POSIX the UTF-8 bytes of the name equal the listed
 * bytes, on Windows its UTF-16 code units equal the listed ones. A directory that cannot be listed throws.
 */
function lists(directory: string, name: string): boolean {
  if (WINDOWS) return readdirSync(directory).includes(name);
  const bytes = Buffer.from(name, 'utf8');
  return readdirSync(directory, { encoding: 'buffer' }).some(listed => listed.equals(bytes));
}

/**
 * lstat of one examined component. Node reports a Windows reparse point whose tag is a symbolic link or a junction
 * (a mount point) as a symbolic link.
 */
function examine(path: string): Stats | Error {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
}

/** stat of one intermediate component of an external path that is a symbolic link: the directory it names. */
function examineFollowed(path: string): Stats | Error {
  try {
    return statSync(path);
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
}

/** Opens the file once and reads its bytes and its identity from that handle. */
function readOnce(path: string): { bytes: Uint8Array; identity: string } | { failure: string } {
  let fd: number;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch (error) {
    return { failure: reason(error) };
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) return { failure: 'it is not a regular file' };
    const bytes = readFileSync(fd);
    return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), identity: `${stat.dev}:${stat.ino}` };
  } catch (error) {
    return { failure: reason(error) };
  } finally {
    closeSync(fd);
  }
}

/** Step 1: the set file. Returns its bytes or its one error. */
function readSetFile(path: string): Uint8Array | DbspecSetError {
  const nameError = setNameError(path, WINDOWS);
  if (nameError !== null) return nameError;
  const { prefix, name } = splitSetPath(path, WINDOWS);
  const root = rootOf(prefix);
  const fileError = (detail: string): DbspecSetError => setError('set.file', path, `${path}: ${detail}`);
  const rootStat = examine(root);
  if (rootStat instanceof Error) return fileError(`its directory ${root} cannot be examined: ${reason(rootStat)}`);
  if (rootStat.isSymbolicLink()) return setError('set.symlink', path, `${path}: its directory ${root} is a symbolic link`);
  if (!rootStat.isDirectory()) return fileError(`${root} is not a directory`);
  try {
    if (!lists(root, name)) return fileError(`its directory ${root} lists no file named ${name}`);
  } catch (error) {
    return fileError(`its directory ${root} cannot be listed: ${reason(error)}`);
  }
  const fileStat = examine(path);
  if (fileStat instanceof Error) return fileError(`it cannot be examined: ${reason(fileStat)}`);
  if (fileStat.isSymbolicLink()) return setError('set.symlink', path, `${path} is a symbolic link`);
  if (!fileStat.isFile()) return fileError('it is not a regular file');
  const read = readOnce(path);
  if ('failure' in read) return fileError(`it cannot be read: ${read.failure}`);
  return read.bytes;
}

/**
 * Step 3 for one path with the normal form: every prefix of its joined path that ends after a segment, examined
 * without following a symbolic link, except that an intermediate prefix of an external path that is a link is
 * examined through it. Returns the first error, or null.
 */
function examinePath(entry: DbspecSetPath, prefix: string, external: boolean): DbspecSetError | null {
  const segments = entry.written.split('/');
  const fileError = (detail: string): DbspecSetError => setError('set.file', entry.path, `${entry.path}: ${detail}`);
  let parent = rootOf(prefix);
  let current = prefix;
  for (let i = 0; i < segments.length; i++) {
    const segment = present(segments[i], 'segments[i]');
    current += (i === 0 ? '' : '/') + segment;
    const last = i === segments.length - 1;
    // The name is compared before the lstat, so that a spelling that only a case-folding file system resolves is
    // set.file on every platform, whatever it names there.
    if (segment !== '..') {
      try {
        if (!lists(parent, segment)) return fileError(`${parent} lists no entry named ${segment}`);
      } catch (error) {
        return fileError(`${parent} cannot be listed: ${reason(error)}`);
      }
    }
    const lstat = examine(current);
    if (lstat instanceof Error) return fileError(`${current} cannot be examined: ${reason(lstat)}`);
    const stat = external && !last && lstat.isSymbolicLink() ? examineFollowed(current) : lstat;
    if (stat instanceof Error) return fileError(`${current} cannot be examined: ${reason(stat)}`);
    if (stat.isSymbolicLink()) return setError('set.symlink', entry.path, `${entry.path}: ${current} is a symbolic link`);
    if (last && !stat.isFile()) return fileError(`${current} is not a regular file`);
    if (!last && !stat.isDirectory()) return fileError(`${current} is not a directory`);
    parent = current;
  }
  return null;
}

/**
 * Reads the set file at `path` and the files it lists (docs/spec/dbspec.md "Document sets"). The first two steps stop at
 * their first error; steps 3 and 4 report every path that breaks them, each with its first error. The bytes of the
 * listed files are not checked: the caller gives each to readDbspecBytes with its path.
 */
export function readDbspecSet(path: string): DbspecSetResult {
  if (typeof path !== 'string') throw new TypeError('set file path must be a string');
  const bytes = readSetFile(path);
  if (!(bytes instanceof Uint8Array)) return failure([bytes]);
  const parsed = parseSetOn(bytes, path, WINDOWS);
  if (parsed.documents === null) return failure(parsed.errors);
  const { prefix } = splitSetPath(path, WINDOWS);
  const entries = [...parsed.documents, ...parsed.external];
  // Step 3: the normal form, then the components of each path, in order.
  const stepThree: DbspecSetError[] = [];
  const passed: DbspecSetPath[] = [];
  for (const [index, entry] of entries.entries()) {
    const error = entry.error ?? examinePath(entry, prefix, index >= parsed.documents.length);
    if (error === null) passed.push(entry);
    else stepThree.push(error);
  }
  // Step 4: one open per file, its bytes and its identity from the same handle.
  const stepFour: DbspecSetError[] = [];
  const seen = new Map<string, string>();
  const files = new Map<DbspecSetPath, DbspecSetFile>();
  for (const entry of passed) {
    const read = readOnce(entry.path);
    if ('failure' in read) {
      stepFour.push(setError('set.file', entry.path, `${entry.path} cannot be read: ${read.failure}`));
      continue;
    }
    const earlier = seen.get(read.identity);
    if (earlier !== undefined) {
      stepFour.push(setError('set.duplicate', entry.path, `${entry.path} names the file that ${earlier} names`));
      continue;
    }
    seen.set(read.identity, entry.path);
    files.set(entry, Object.freeze({ path: entry.path, bytes: read.bytes }));
  }
  if (stepThree.length > 0 || stepFour.length > 0) return failure([...stepThree, ...stepFour]);
  const list = (paths: readonly DbspecSetPath[]): readonly DbspecSetFile[] => Object.freeze(paths.map(p => present(files.get(p), 'files.get(p)')));
  const noErrors: readonly [] = Object.freeze([]);
  return Object.freeze({ documents: list(parsed.documents), external: list(parsed.external), errors: noErrors });
}
