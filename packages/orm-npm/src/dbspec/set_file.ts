// The rules of a set file that read no file (docs/dbspec.md "Document sets"): the name dbspec-set.json of the last
// segment of the set file's path (step 1), the JSON of step 2 and the normal form of each path (step 3). This module
// reads no Node global and loads no driver: the bytes come from the caller, as a Uint8Array, so it runs in a browser
// as in Node. readDbspecSet (set_read.ts) runs it between the checks of the file tree.

/** The name of every set file. */
export const DBSPEC_SET_NAME = 'dbspec-set.json';

/** The rules of the set reader. */
export type DbspecSetRule =
  | 'set.file'
  | 'set.symlink'
  | 'set.json'
  | 'set.schema'
  | 'set.key'
  | 'set.empty'
  | 'set.path'
  | 'set.duplicate';

/** One error of the set reader: its rule, the path it concerns and a message that names that path. */
export interface DbspecSetError {
  readonly rule: DbspecSetRule;
  readonly path: string;
  readonly message: string;
}

/**
 * One path of a set file: as written, joined to the prefix of the set file's path, and its `set.path` error, or null
 * when it has the normal form.
 */
export interface DbspecSetPath {
  readonly written: string;
  readonly path: string;
  readonly error: DbspecSetError | null;
}

/**
 * The result of parseSet. When the name or the JSON is wrong, `documents` and `external` are null and `errors` holds
 * that one error. Otherwise they list every path in written order, and `errors` holds the `set.path` errors of the
 * paths without a normal form, `documents` first and then `external`.
 */
export type DbspecSetParseResult =
  | { readonly documents: readonly DbspecSetPath[]; readonly external: readonly DbspecSetPath[]; readonly errors: readonly DbspecSetError[] }
  | { readonly documents: null; readonly external: null; readonly errors: readonly [DbspecSetError] };

/** The maximum nesting of the set file's JSON; the top-level object counts as one level. */
const MAX_DEPTH = 64;
const KEYS = new Set(['schema', 'documents', 'external']);

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function setError(rule: DbspecSetRule, path: string, message: string): DbspecSetError {
  return Object.freeze({ rule, path, message });
}

function failed(error: DbspecSetError): DbspecSetParseResult {
  return Object.freeze({ documents: null, external: null, errors: Object.freeze([error]) as readonly [DbspecSetError] });
}

/**
 * Splits the path of a set file at its last separator: `/`, and on Windows `/` or `\`. The prefix keeps the
 * separator and may be empty.
 */
export function splitSetPath(path: string, windows: boolean): { readonly prefix: string; readonly name: string } {
  let at = path.lastIndexOf('/');
  if (windows) at = Math.max(at, path.lastIndexOf('\\'));
  return { prefix: path.slice(0, at + 1), name: path.slice(at + 1) };
}

/** The `set.file` error of a set file whose last segment is not dbspec-set.json, or null. */
export function setNameError(path: string, windows: boolean): DbspecSetError | null {
  const { name } = splitSetPath(path, windows);
  if (name === DBSPEC_SET_NAME) return null;
  return setError('set.file', path, `${path} is not a set file: its name is not ${DBSPEC_SET_NAME}`);
}

/**
 * Parses the bytes of the set file at `path` under the rules that read no file: the name dbspec-set.json of the last
 * segment of `path`, the JSON and the normal form of each path. A segment of `path` ends at `/`. The joined path of a
 * written path is the prefix of `path`, the path with its last segment removed, followed by the written path
 * unchanged.
 */
export function parseSet(bytes: Uint8Array, path: string): DbspecSetParseResult {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('set file bytes must be a Uint8Array');
  if (typeof path !== 'string') throw new TypeError('set file path must be a string');
  return parseSetOn(bytes, path, false);
}

/** parseSet on the platform that `windows` names: on Windows a segment of `path` ends at `/` or `\`. */
export function parseSetOn(bytes: Uint8Array, path: string, windows: boolean): DbspecSetParseResult {
  const nameError = setNameError(path, windows);
  if (nameError !== null) return failed(nameError);
  const json = (rule: DbspecSetRule, detail: string): DbspecSetParseResult => failed(setError(rule, path, `${path}: ${detail}`));

  // UTF-8 with no byte order mark, before parsing. The decoder keeps a byte order mark (ignoreBOM) and rejects an
  // invalid byte (fatal).
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return json('set.json', 'the set file is not valid UTF-8');
  }
  if (text.startsWith('﻿')) return json('set.json', 'the set file starts with a byte order mark');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return json('set.json', `the set file is not JSON: ${(error as Error).message}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return json('set.json', 'the set file is not one JSON object');
  // JSON.parse reports neither the depth, nor a lone surrogate escape, nor a repeated key: a token scan checks them.
  const scan = scanJson(text);
  if (scan.depth) return json('set.json', `the set file nests deeper than ${MAX_DEPTH} levels`);
  if (scan.loneSurrogate) return json('set.json', 'a string of the set file escapes a lone surrogate');
  if (scan.repeated !== null) return json('set.key', `the key ${JSON.stringify(scan.repeated)} appears twice`);

  const object = value as Record<string, unknown>;
  const unknown = Object.keys(object).filter(key => !KEYS.has(key)).sort(compareCodePoints);
  if (unknown.length > 0) return json('set.key', `unknown key${unknown.length > 1 ? 's' : ''} ${unknown.map(k => JSON.stringify(k)).join(', ')}`);
  if (!Object.hasOwn(object, 'schema')) return json('set.schema', 'the key "schema" is missing');
  if (object.schema !== 1) return json('set.schema', `"schema" is ${JSON.stringify(object.schema) ?? String(object.schema)}, not the number 1`);
  if (!Object.hasOwn(object, 'documents')) return json('set.key', 'the key "documents" is missing');
  if (!isStrings(object.documents)) return json('set.key', '"documents" is not an array of strings');
  if (object.documents.length === 0) return json('set.empty', '"documents" is empty');
  if (Object.hasOwn(object, 'external') && !isStrings(object.external)) return json('set.key', '"external" is not an array of strings');

  const { prefix } = splitSetPath(path, windows);
  const errors: DbspecSetError[] = [];
  const entries = (written: readonly string[], external: boolean): readonly DbspecSetPath[] => Object.freeze(written.map(w => {
    const problem = normalFormProblem(w, external);
    const error = problem === null ? null : setError('set.path', path, `${path}: the ${external ? 'external' : 'document'} path ${JSON.stringify(w)} ${problem}`);
    if (error !== null) errors.push(error);
    return Object.freeze({ written: w, path: prefix + w, error });
  }));
  const documents = entries(object.documents, false);
  const external = entries((object.external as string[] | undefined) ?? [], true);
  return Object.freeze({ documents, external, errors: Object.freeze(errors) });
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string');
}

/** Compares two strings by code point, not by UTF-16 code unit. */
function compareCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/**
 * Scans JSON text that JSON.parse accepted, without building a value: whether it nests deeper than MAX_DEPTH, whether
 * a string escapes a lone surrogate and the first key that an object repeats, the keys compared after unescaping.
 */
function scanJson(text: string): { depth: boolean; loneSurrogate: boolean; repeated: string | null } {
  // Each open container: its key set when it is an object, and whether the next string in it is a key.
  const stack: { keys: Set<string> | null; expectKey: boolean }[] = [];
  let depth = false;
  let loneSurrogate = false;
  let repeated: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '[') {
      stack.push({ keys: c === '{' ? new Set() : null, expectKey: c === '{' });
      if (stack.length > MAX_DEPTH) depth = true;
    } else if (c === '}' || c === ']') {
      stack.pop();
    } else if (c === ',') {
      const top = stack.at(-1);
      if (top !== undefined && top.keys !== null) top.expectKey = true;
    } else if (c === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const token = text.slice(i, end + 1);
      if (hasLoneSurrogateEscape(token)) loneSurrogate = true;
      const top = stack.at(-1);
      if (top !== undefined && top.keys !== null && top.expectKey) {
        top.expectKey = false;
        const key = JSON.parse(token) as string;
        if (top.keys.has(key) && repeated === null) repeated = key;
        top.keys.add(key);
      }
      i = end;
    }
  }
  return { depth, loneSurrogate, repeated };
}

/** Whether a JSON string token escapes a high surrogate not followed by an escaped low one, or a lone low one. */
function hasLoneSurrogateEscape(token: string): boolean {
  const units: number[] = [];
  for (let i = 1; i < token.length - 1; i++) {
    if (token[i] !== '\\') continue;
    if (token[i + 1] === 'u') {
      units.push(i);
      i += 5;
    } else {
      i++;
    }
  }
  const unit = (at: number): number => parseInt(token.slice(at + 2, at + 6), 16);
  for (let k = 0; k < units.length; k++) {
    const u = unit(units[k]!);
    if (u >= 0xd800 && u <= 0xdbff) {
      const next = units[k + 1];
      if (next === units[k]! + 6 && unit(next) >= 0xdc00 && unit(next) <= 0xdfff) { k++; continue; }
      return true;
    }
    if (u >= 0xdc00 && u <= 0xdfff) return true;
  }
  return false;
}

/** The characters that a segment never holds: `/`, `\`, `:`, `<`, `>`, `"`, `|`, `?`, `*`, NUL and U+0001 to U+001F. */
const FORBIDDEN = /[/\\:<>"|?*\u0000-\u001f]/;
/** The device names of Windows, matched against the part of a segment before its first `.`, trailing spaces removed. */
const DEVICE = /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])$/i;

/** Why a written path has no normal form, or null when it has one. */
function normalFormProblem(path: string, external: boolean): string | null {
  const segments = path.split('/');
  if (!segments.at(-1)!.endsWith('.dbs')) return 'does not end in a segment ending in .dbs';
  let leading = true;
  for (const segment of segments) {
    if (segment === '..') {
      if (!external) return 'has a .. segment';
      if (!leading) return 'has a .. segment after another segment';
      continue;
    }
    leading = false;
    if (segment === '') return 'has an empty segment';
    if (FORBIDDEN.test(segment)) return `has the segment ${JSON.stringify(segment)} with a character that a path name cannot hold`;
    if (segment === '.') return 'has a . segment';
    if (segment.endsWith('.') || segment.endsWith(' ')) return `has the segment ${JSON.stringify(segment)} ending in a dot or a space`;
    if (DEVICE.test(segment.split('.')[0]!.replace(/ +$/, ''))) return `has the segment ${JSON.stringify(segment)} named after a Windows device`;
  }
  return null;
}
