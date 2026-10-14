// The document set of a document (docs/plans/editor-stack.md ruling 4): resolveSet finds the dbspec-set.json in the
// nearest ancestor directory that lists the document in `documents`, reads it by the four steps of docs/dbspec.md
// "Document sets" and gives the other documents of the set, by name, for openDocument. The rules that read no file are
// parseSet's; the steps that read the file tree run here through an injected host, so this module reads no Node
// module and no Node global and runs in a browser as in Node. The command line passes a node:fs host (cli/host.ts).
import {
  parseDbspecSet,
  parseSet,
  readDbspecBytes,
  type DbspecRule,
  type DbspecSetError,
  type DbspecSetPath,
  type DbspecSetRule,
} from '@polyspec/orm/dbspec';

/** The name of every set file. */
const SET_NAME = 'dbspec-set.json';
/** The column of the document name in the header line `dbspec 1 <document>`, where a repeated name is reported. */
const HEADER_NAME_COLUMN = 10;

/** The kind of an entry that the host examines without following a symbolic link. */
export type SetHostEntry = 'file' | 'directory' | 'symlink' | 'other';

/**
 * The file system of resolveSet. Every path has `/` separators. A method that fails throws an Error whose message is
 * the platform's error.
 */
export interface SetHost {
  /**
   * The kind of the entry at `path`, examined without following a symbolic link at its last component (POSIX
   * `lstat`; on Windows a reparse point whose tag is a name surrogate is a symbolic link), or null when no entry is
   * there.
   */
  lstat(path: string): SetHostEntry | null;
  /** The names that the directory lists: each the UTF-8 bytes of a POSIX name, or the string of a Windows name. */
  list(directory: string): readonly (Uint8Array | string)[];
  /**
   * Opens the regular file at `path` once and gives its bytes and its identity from that handle: the device and inode
   * of POSIX `fstat`, or the volume serial number and the file index of Windows, as one string. A file that is not
   * regular throws.
   */
  open(path: string): { readonly bytes: Uint8Array; readonly identity: string };
}

/** The rules of resolveSet: those of the set reader, and `set.owner` for a document that two set files list. */
export type ResolveRule = DbspecSetRule | 'set.owner';

/** An error of resolveSet: its rule, the path it concerns and a message that names that path. */
export interface ResolveError {
  readonly rule: ResolveRule;
  readonly path: string;
  readonly message: string;
}

/** A diagnostic of another file of the set, at its path: the byte check, a header without a name or a repeated name. */
export interface SetFileDiagnostic {
  readonly path: string;
  readonly rule: DbspecRule;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

/**
 * The result of resolveSet. With no error: the set file that lists the document, or null when none does and the
 * document is a set of itself alone; `set`, the other documents of the set by their header names, for openDocument;
 * and the diagnostics of the other files. With errors: no set and no diagnostics.
 */
export type ResolvedSet =
  | {
    readonly setFile: string | null;
    readonly set: Readonly<Record<string, string>>;
    readonly diagnostics: readonly SetFileDiagnostic[];
    readonly errors: readonly [];
  }
  | { readonly setFile: string | null; readonly set: null; readonly diagnostics: readonly []; readonly errors: readonly ResolveError[] };

const encoder = new TextEncoder();

function error(rule: ResolveRule, path: string, message: string): ResolveError {
  return Object.freeze({ rule, path, message });
}

function reason(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * The root of a path of `/` separators and its segments. The root is `/`, a drive such as `C:/` or a share such as
 * `//server/share/`; every segment is a name, neither empty nor `.` nor `..`.
 */
function splitAbsolute(path: unknown): { root: string; segments: string[] } {
  if (typeof path !== 'string') throw new TypeError('resolveSet takes the path of a document as a string');
  const root = /^[A-Za-z]:\//.exec(path)?.[0] ?? /^\/\/[^/]+\/[^/]+\//.exec(path)?.[0] ?? (/^\/(?!\/)/.test(path) ? '/' : null);
  if (root === null) throw new TypeError(`resolveSet takes an absolute path with / separators: ${path}`);
  const segments = path.slice(root.length).split('/');
  if (segments.some(s => s === '' || s === '.' || s === '..')) {
    throw new TypeError(`resolveSet takes a path with no empty, . or .. segment: ${path}`);
  }
  return { root, segments };
}

/**
 * The root of a set as step 1 states it: the prefix without its trailing separators, so that lstat does not follow
 * a symbolic link that the root is. A root of only separators stays as it is, and so does a drive root such as `C:/`.
 */
function rootOf(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, '');
  if (trimmed === '') return prefix;
  if (/^[A-Za-z]:$/.test(trimmed)) return prefix;
  return trimmed;
}

/**
 * Whether `directory` lists `name`: a POSIX name by its UTF-8 bytes, a Windows name by its UTF-16 code units. A
 * directory that cannot be listed throws.
 */
function lists(host: SetHost, directory: string, name: string): boolean {
  const bytes = encoder.encode(name);
  return host.list(directory).some(listed => {
    if (typeof listed === 'string') return listed === name;
    return listed.length === bytes.length && listed.every((b, i) => b === bytes[i]);
  });
}

/** lstat of one examined component, or the error that the host threw. */
function examine(host: SetHost, path: string): SetHostEntry | null | Error {
  try {
    return host.lstat(path);
  } catch (thrown) {
    return thrown instanceof Error ? thrown : new Error(String(thrown));
  }
}

/** Opens the file once and reads its bytes and its identity from that handle, or gives why it cannot. */
function readOnce(host: SetHost, path: string): { bytes: Uint8Array; identity: string } | { failure: string } {
  try {
    const { bytes, identity } = host.open(path);
    return { bytes, identity };
  } catch (thrown) {
    return { failure: reason(thrown) };
  }
}

/**
 * Whether `directory` holds a set file: an entry that lstat finds at `<directory>/dbspec-set.json` and that the
 * directory lists by exactly that name. A name that only a case-folding file system resolves to it is another name,
 * so it is not a set file.
 */
function holdsSetFile(host: SetHost, prefix: string, setFile: string): boolean | ResolveError {
  const entry = examine(host, setFile);
  if (entry instanceof Error) return error('set.file', setFile, `${setFile}: it cannot be examined: ${entry.message}`);
  if (entry === null) return false;
  const root = rootOf(prefix);
  try {
    return lists(host, root, SET_NAME);
  } catch (thrown) {
    return error('set.file', setFile, `${setFile}: its directory ${root} cannot be listed: ${reason(thrown)}`);
  }
}

/** Step 1: the set file, whose name is dbspec-set.json. Returns its bytes or its one error. */
function readSetFile(host: SetHost, prefix: string, path: string): Uint8Array | ResolveError {
  const root = rootOf(prefix);
  const fileError = (detail: string): ResolveError => error('set.file', path, `${path}: ${detail}`);
  const rootStat = examine(host, root);
  if (rootStat instanceof Error) return fileError(`its directory ${root} cannot be examined: ${rootStat.message}`);
  if (rootStat === null) return fileError(`its directory ${root} does not exist`);
  if (rootStat === 'symlink') return error('set.symlink', path, `${path}: its directory ${root} is a symbolic link`);
  if (rootStat !== 'directory') return fileError(`${root} is not a directory`);
  try {
    if (!lists(host, root, SET_NAME)) return fileError(`its directory ${root} lists no file named ${SET_NAME}`);
  } catch (thrown) {
    return fileError(`its directory ${root} cannot be listed: ${reason(thrown)}`);
  }
  const fileStat = examine(host, path);
  if (fileStat instanceof Error) return fileError(`it cannot be examined: ${fileStat.message}`);
  if (fileStat === null) return fileError('it does not exist');
  if (fileStat === 'symlink') return error('set.symlink', path, `${path} is a symbolic link`);
  if (fileStat !== 'file') return fileError('it is not a regular file');
  const read = readOnce(host, path);
  if ('failure' in read) return fileError(`it cannot be read: ${read.failure}`);
  return read.bytes;
}

/**
 * Step 3 for one path with the normal form: every prefix of its joined path that ends after a segment, examined
 * without following a symbolic link, each segment other than `..` compared with the names its directory lists before
 * its lstat. Returns the first error, or null.
 */
function examinePath(host: SetHost, entry: DbspecSetPath, prefix: string): ResolveError | null {
  const segments = entry.written.split('/');
  const fileError = (detail: string): ResolveError => error('set.file', entry.path, `${entry.path}: ${detail}`);
  let parent = rootOf(prefix);
  let current = prefix;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    current += (i === 0 ? '' : '/') + segment;
    const last = i === segments.length - 1;
    if (segment !== '..') {
      try {
        if (!lists(host, parent, segment)) return fileError(`${parent} lists no entry named ${segment}`);
      } catch (thrown) {
        return fileError(`${parent} cannot be listed: ${reason(thrown)}`);
      }
    }
    const stat = examine(host, current);
    if (stat instanceof Error) return fileError(`${current} cannot be examined: ${stat.message}`);
    if (stat === null) return fileError(`${current} does not exist`);
    if (stat === 'symlink') return error('set.symlink', entry.path, `${entry.path}: ${current} is a symbolic link`);
    if (last && stat !== 'file') return fileError(`${current} is not a regular file`);
    if (!last && stat !== 'directory') return fileError(`${current} is not a directory`);
    parent = current;
  }
  return null;
}

/** A set file that lists the document, with the paths parseSet gives and the written path of the document. */
interface Owner {
  readonly setFile: string;
  readonly prefix: string;
  readonly documents: readonly DbspecSetPath[];
  readonly external: readonly DbspecSetPath[];
  readonly document: DbspecSetPath;
}

/** A listed file read by step 4: its joined path, its bytes and whether it is the document itself. */
interface ListedFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly self: boolean;
}

/** Steps 3 and 4 of the set file that owns the document: the files it lists, read once each, or every error. */
function readListed(host: SetHost, owner: Owner): { files: ListedFile[] } | { errors: ResolveError[] } {
  const entries = [...owner.documents, ...owner.external];
  const stepThree: ResolveError[] = [];
  const passed: DbspecSetPath[] = [];
  for (const entry of entries) {
    const found: DbspecSetError | ResolveError | null = entry.error ?? examinePath(host, entry, owner.prefix);
    if (found === null) passed.push(entry);
    else stepThree.push(error(found.rule, found.path, found.message));
  }
  const stepFour: ResolveError[] = [];
  const seen = new Map<string, string>();
  const files: ListedFile[] = [];
  for (const entry of passed) {
    const read = readOnce(host, entry.path);
    if ('failure' in read) {
      stepFour.push(error('set.file', entry.path, `${entry.path} cannot be read: ${read.failure}`));
      continue;
    }
    const earlier = seen.get(read.identity);
    if (earlier !== undefined) {
      stepFour.push(error('set.duplicate', entry.path, `${entry.path} names the file that ${earlier} names`));
      continue;
    }
    seen.set(read.identity, entry.path);
    files.push({ path: entry.path, bytes: read.bytes, self: entry === owner.document });
  }
  if (stepThree.length > 0 || stepFour.length > 0) return { errors: [...stepThree, ...stepFour] };
  return { files };
}

/**
 * The name that the parser reads from the header of a document text (docs/dbspec.md "Parsing a set"), or the
 * diagnostic of a header that names none.
 */
function headerName(text: string, path: string): string | SetFileDiagnostic {
  const parsed = parseDbspecSet([text], [])[0]!;
  if (parsed.name !== '') return parsed.name;
  const d = parsed.diagnostics.find(x => x.rule === 'header') ?? parsed.diagnostics[0]!;
  return Object.freeze({ path, rule: d.rule, line: d.line, column: d.column, message: d.message });
}

/**
 * The set given to openDocument from the files of the owning set: every other file by its header name. A file that
 * fails the byte check or whose header names no document is a diagnostic at its path and is not in the set. A name
 * that a file repeats from an earlier file, in written order with `documents` first, is `name.duplicate` at the later
 * file; the set keeps the earlier file, and never a file named as the document itself.
 */
function setOf(files: readonly ListedFile[]): { set: Readonly<Record<string, string>>; diagnostics: SetFileDiagnostic[] } {
  const diagnostics: SetFileDiagnostic[] = [];
  const named: { name: string; text: string; self: boolean }[] = [];
  for (const file of files) {
    const read = readDbspecBytes(file.path, file.bytes);
    // The document's own byte check and header are its caller's: the caller reads and opens the document.
    if (read.text === null) {
      if (!file.self) for (const d of read.diagnostics) diagnostics.push(Object.freeze({ path: file.path, rule: d.rule, line: d.line, column: d.column, message: d.message }));
      continue;
    }
    const name = headerName(read.text, file.path);
    if (typeof name !== 'string') {
      if (!file.self) diagnostics.push(name);
      continue;
    }
    if (named.some(n => n.name === name)) {
      diagnostics.push(Object.freeze({
        path: file.path,
        rule: 'name.duplicate' as const,
        line: 1,
        column: HEADER_NAME_COLUMN,
        message: `document ${name} appears twice in the document set`,
      }));
      continue;
    }
    named.push({ name, text: read.text, self: file.self });
  }
  const own = named.find(n => n.self)?.name;
  const set: Record<string, string> = {};
  for (const n of named) if (!n.self && n.name !== own) set[n.name] = n.text;
  return { set: Object.freeze(set), diagnostics };
}

function failure(setFile: string | null, errors: readonly ResolveError[]): ResolvedSet {
  return Object.freeze({ setFile, set: null, diagnostics: Object.freeze([]) as readonly [], errors: Object.freeze([...errors]) });
}

/**
 * Resolves the document set of the document at the absolute `path`, whose separators are `/`, through `host`.
 *
 * Every ancestor directory of the document, from its own up to the root of the file system, is examined for a
 * dbspec-set.json; each one found is read by steps 1 and 2 of the set reader and parseSet, since whether it lists the
 * document cannot be known otherwise, and one that fails there is an error. A set file lists the document when one of
 * its `documents` paths, as written, is the document's path relative to the set file's directory; `external` paths
 * do not count. The nearest set file that lists it owns it and is read by steps 3 and 4; a second set file that lists
 * it, or more, is a `set.owner` error. A document that no set file lists is a set of itself alone: no set file and an empty set.
 */
export function resolveSet(path: string, host: SetHost): ResolvedSet {
  const { root, segments } = splitAbsolute(path);
  const errors: ResolveError[] = [];
  const owners: Owner[] = [];
  for (let depth = segments.length - 1; depth >= 0; depth--) {
    const directory = root + segments.slice(0, depth).join('/');
    const prefix = directory.endsWith('/') ? directory : `${directory}/`;
    const setFile = prefix + SET_NAME;
    const held = holdsSetFile(host, prefix, setFile);
    if (held === false) continue;
    if (held !== true) {
      errors.push(held);
      continue;
    }
    const bytes = readSetFile(host, prefix, setFile);
    if (!(bytes instanceof Uint8Array)) {
      errors.push(bytes);
      continue;
    }
    const parsed = parseSet(bytes, setFile);
    if (parsed.documents === null) {
      errors.push(...parsed.errors.map(e => error(e.rule, e.path, e.message)));
      continue;
    }
    const relative = segments.slice(depth).join('/');
    const document = parsed.documents.find(p => p.written === relative);
    if (document !== undefined) owners.push({ setFile, prefix, documents: parsed.documents, external: parsed.external, document });
  }
  const owner = owners[0];
  if (owner !== undefined) {
    const listed = readListed(host, owner);
    if ('errors' in listed) errors.push(...listed.errors);
    if (owners.length > 1) {
      errors.push(error('set.owner', path, `${path} is in the documents of ${owners.length} set files: ${owners.map(o => o.setFile).join(' and ')}`));
    }
    if (errors.length > 0) return failure(owner.setFile, errors);
    const { set, diagnostics } = setOf((listed as { files: ListedFile[] }).files);
    return Object.freeze({ setFile: owner.setFile, set, diagnostics: Object.freeze(diagnostics), errors: Object.freeze([]) as readonly [] });
  }
  if (errors.length > 0) return failure(null, errors);
  return Object.freeze({ setFile: null, set: Object.freeze({}), diagnostics: Object.freeze([]), errors: Object.freeze([]) as readonly [] });
}
