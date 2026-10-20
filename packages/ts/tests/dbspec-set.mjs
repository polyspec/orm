// The set reader vectors (tests/dbspec/set-files.json, docs/spec/dbspec.md "Document sets"). Every case builds its file
// tree in a fresh temporary directory, with real symbolic and hard links, and calls readDbspecSet with the tree root
// joined with the case's `set`. The cases that need no file tree also run through parseSet, from the Node entry and
// from the browser-safe `@polyspec/orm/dbspec` entry. The vector file is read strictly: an unknown or a missing
// field is an error, and no case is skipped.
//
// Usage: node --test packages/ts/tests/dbspec-set.mjs (after the build)
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest } from '../../../tests/testcase.mts';
import { parseSet, readDbspecSet } from '../dist/dbspec/index.js';
import { parseSet as browserParseSet } from '../dist/dbspec/entry.js';

// The deadline of one case: it writes a tree of a few files and reads it.
const TIMEOUT = 15000;
const RULES = new Set(['set.file', 'set.symlink', 'set.json', 'set.schema', 'set.key', 'set.empty', 'set.path', 'set.duplicate']);
// The rules that parseSet decides from the bytes and the path alone, without a file tree.
const PARSE_RULES = new Set(['set.json', 'set.schema', 'set.key', 'set.empty', 'set.path']);
const SET_NAME = 'dbspec-set.json';

const vectorPath = fileURLToPath(new URL('../../../tests/dbspec/set-files.json', import.meta.url));
const vectors = JSON.parse(readFileSync(vectorPath, 'utf8'));

/** Asserts that `value` is a plain object with exactly the keys `keys`. */
function exactKeys(value, keys, where) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${where} is an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${where} has exactly the keys ${keys.join(', ')}`);
}

function stringList(value, where) {
  assert.ok(Array.isArray(value) && value.every(v => typeof v === 'string'), `${where} is a list of strings`);
  return value;
}

/** Reads one case strictly and returns it in a checked form. */
function readCase(c, index) {
  const where = `cases[${index}]`;
  exactKeys(c, ['id', 'tree', 'set', 'want'], where);
  assert.equal(typeof c.id, 'string', `${where}.id is a string`);
  assert.equal(typeof c.set, 'string', `${where}.set is a string`);
  assert.ok(c.tree !== null && typeof c.tree === 'object' && !Array.isArray(c.tree), `${c.id}: tree is an object`);
  for (const [path, entry] of Object.entries(c.tree)) {
    assert.ok(entry !== null && typeof entry === 'object' && Object.keys(entry).length === 1, `${c.id}: tree ${path} has one kind`);
    const [kind] = Object.keys(entry);
    assert.ok(['file', 'hex', 'symlink', 'hardlink'].includes(kind), `${c.id}: tree ${path} kind ${kind} is known`);
    assert.equal(typeof entry[kind], 'string', `${c.id}: tree ${path} ${kind} is a string`);
    if (kind === 'hex') assert.match(entry.hex, /^(?:[0-9a-f]{2})*$/, `${c.id}: tree ${path} hex`);
  }
  const want = c.want;
  if (want !== null && typeof want === 'object' && 'errors' in want) {
    exactKeys(want, ['errors'], `${c.id}: want`);
    assert.ok(Array.isArray(want.errors) && want.errors.length > 0, `${c.id}: want.errors is a non-empty list`);
    want.errors.forEach((e, i) => {
      exactKeys(e, ['rule', 'path'], `${c.id}: want.errors[${i}]`);
      assert.ok(RULES.has(e.rule), `${c.id}: rule ${e.rule} is a set rule`);
      assert.equal(typeof e.path, 'string', `${c.id}: want.errors[${i}].path is a string`);
    });
  } else {
    exactKeys(want, ['documents', 'external'], `${c.id}: want`);
    stringList(want.documents, `${c.id}: want.documents`);
    stringList(want.external, `${c.id}: want.external`);
  }
  return c;
}

exactKeys(vectors, ['requirements', 'version', 'note', 'cases'], 'set-files.json');
assert.equal(vectors.version, 1, 'set-files.json version');
assert.equal(typeof vectors.note, 'string', 'set-files.json note');
assert.ok(Array.isArray(vectors.cases) && vectors.cases.length > 0, 'set-files.json cases');
const all = vectors.cases.map(readCase);
assert.equal(new Set(all.map(c => c.id)).size, all.length, 'case ids are unique');

/**
 * The bytes that the tree entry at `path` holds, following hard links to the file they name. A path below a symbolic
 * link to a directory holds the bytes of the file that it reaches.
 */
function treeBytes(tree, path) {
  const entry = tree[path];
  if (entry === undefined) {
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++) {
      const link = segments.slice(0, i).join('/');
      if (tree[link] !== undefined && 'symlink' in tree[link]) {
        return treeBytes(tree, posix.normalize(posix.join(posix.dirname(link), tree[link].symlink)) + path.slice(link.length));
      }
    }
  }
  assert.ok(entry !== undefined, `tree path ${path} exists`);
  if ('file' in entry) return Buffer.from(entry.file, 'utf8');
  if ('hex' in entry) return Buffer.from(entry.hex, 'hex');
  if ('hardlink' in entry) return treeBytes(tree, entry.hardlink);
  throw new Error(`tree path ${path} is a symbolic link, which has no bytes`);
}

/** Writes the tree under a new empty temporary directory and returns that directory. */
function build(tree) {
  const root = mkdtempSync(join(tmpdir(), 'orm-ts-set-'));
  for (const [path, entry] of Object.entries(tree)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    if ('file' in entry) writeFileSync(target, entry.file, 'utf8');
    else if ('hex' in entry) writeFileSync(target, Buffer.from(entry.hex, 'hex'));
    else if ('hardlink' in entry) linkSync(join(root, entry.hardlink), target);
    else {
      // Windows needs the kind of the target; POSIX ignores it.
      let type = 'file';
      try { if (statSync(join(dirname(target), entry.symlink)).isDirectory()) type = 'dir'; } catch { /* a missing target is a file link */ }
      symlinkSync(entry.symlink, target, type);
    }
  }
  return root;
}

function checkMessages(errors) {
  for (const e of errors) {
    assert.deepEqual(Object.keys(e).sort(), ['message', 'path', 'rule']);
    assert.ok(typeof e.message === 'string' && e.message.includes(e.path), `the message names the path: ${e.message}`);
  }
}

// readSet reads the case's file tree with readDbspecSet.
function readSet(c) {
  const root = build(c.tree);
  try {
    const result = readDbspecSet(`${root}/${c.set}`);
    if ('errors' in c.want) {
      assert.equal(result.documents, null);
      assert.equal(result.external, null);
      assert.deepEqual(result.errors.map(e => ({ rule: e.rule, path: e.path })), c.want.errors.map(e => ({ rule: e.rule, path: `${root}/${e.path}` })));
      checkMessages(result.errors);
      return;
    }
    assert.deepEqual(result.errors, []);
    for (const list of ['documents', 'external']) {
      assert.deepEqual(result[list].map(f => f.path), c.want[list].map(p => `${root}/${p}`), `${list} paths`);
      result[list].forEach((f, i) => {
        assert.ok(f.bytes instanceof Uint8Array, `${list}[${i}] bytes are a Uint8Array`);
        assert.deepEqual(Buffer.from(f.bytes), treeBytes(c.tree, posix.normalize(c.want[list][i])), `${list}[${i}] bytes`);
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Whether parseSet decides the case without a file tree: a rejecting case whose every error is a rule that parseSet
 * decides, or whose set path does not end in the name dbspec-set.json.
 */
function needsNoTree(c) {
  if (!('errors' in c.want)) return false;
  if (posix.basename(c.set) !== SET_NAME) return c.want.errors.every(e => e.rule === 'set.file' && e.path === c.set);
  return c.want.errors.every(e => PARSE_RULES.has(e.rule));
}

const treeless = all.filter(needsNoTree);
assert.ok(treeless.length > 0, 'some cases need no file tree');
// parseTreeless rejects a case that needs no file tree with parseSet of both entries.
function parseTreeless(c) {
  for (const [entry, parse] of [['node', parseSet], ['browser', browserParseSet]]) {
    // The set file of a case named otherwise is still read for its bytes; the name alone rejects it.
    const bytes = new Uint8Array(treeBytes(c.tree, c.set));
    const result = parse(bytes, c.set);
    assert.deepEqual(result.errors.map(e => ({ rule: e.rule, path: e.path })), c.want.errors, entry);
    checkMessages(result.errors);
  }
}

// parsePaths: parseSet of an accepting case gives no error and the joined paths that the reader returns.
function parsePaths(c) {
  const result = browserParseSet(new Uint8Array(treeBytes(c.tree, c.set)), c.set);
  assert.deepEqual(result.errors, []);
  for (const list of ['documents', 'external']) {
    assert.deepEqual(result[list].map(p => p.path), c.want[list], `${list} paths`);
    for (const p of result[list]) assert.equal(p.error, null);
  }
}

// Each case is one test: the reader, then parseSet where it decides the case.
for (const c of all) {
  caseTest(c.id, TIMEOUT, () => {
    readSet(c);
    if (treeless.includes(c)) parseTreeless(c);
    if (!('errors' in c.want)) parsePaths(c);
  });
}
