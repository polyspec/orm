// The set reader vectors (tests/dbspec/set-files.json, docs/dbspec.md "Document sets"). Every case builds its file
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
import { caseTest } from '../../../tests/testcase.mjs';
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

exactKeys(vectors, ['version', 'note', 'cases'], 'set-files.json');
assert.equal(vectors.version, 1, 'set-files.json version');
assert.equal(typeof vectors.note, 'string', 'set-files.json note');
assert.ok(Array.isArray(vectors.cases) && vectors.cases.length > 0, 'set-files.json cases');
const all = vectors.cases.map(readCase);
assert.equal(new Set(all.map(c => c.id)).size, all.length, 'case ids are unique');

/** The bytes that the tree entry at `path` holds, following hard links to the file they name. */
function treeBytes(tree, path) {
  const entry = tree[path];
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

for (const c of all) {
  caseTest(`set-files ${c.id} readDbspecSet`, TIMEOUT, () => {
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
  });
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
for (const c of treeless) {
  for (const [entry, parse] of [['node', parseSet], ['browser', browserParseSet]]) {
    caseTest(`set-files ${c.id} parseSet ${entry}`, TIMEOUT, () => {
      // The set file of a case named otherwise is still read for its bytes; the name alone rejects it.
      const bytes = new Uint8Array(treeBytes(c.tree, c.set));
      const result = parse(bytes, c.set);
      assert.deepEqual(result.errors.map(e => ({ rule: e.rule, path: e.path })), c.want.errors);
      checkMessages(result.errors);
    });
  }
}

// parseSet of an accepting case gives no error and the joined paths that the reader returns.
for (const c of all.filter(c => !('errors' in c.want))) {
  caseTest(`set-files ${c.id} parseSet paths`, TIMEOUT, () => {
    const result = browserParseSet(new Uint8Array(treeBytes(c.tree, c.set)), c.set);
    assert.deepEqual(result.errors, []);
    for (const list of ['documents', 'external']) {
      assert.deepEqual(result[list].map(p => p.path), c.want[list], `${list} paths`);
      for (const p of result[list]) assert.equal(p.error, null);
    }
  });
}

caseTest('set-files parseSet takes a Uint8Array and a string', TIMEOUT, () => {
  assert.throws(() => browserParseSet('{}', 'dbspec-set.json'), TypeError);
  assert.throws(() => browserParseSet(new Uint8Array(), 1), TypeError);
  assert.throws(() => readDbspecSet(1), TypeError);
});

// Edges of the token scan and the normal form that the shared vectors do not spell: each text is a set file at
// `app/dbspec-set.json` and gives no error (null) or the one rule.
const edges = [
  ['a paired surrogate escape', '{"schema": 1, "documents": ["\\ud83d\\ude00.dbs"]}', null],
  ['a lone low surrogate escape', '{"schema": 1, "documents": ["\\ude00.dbs"]}', 'set.json'],
  ['a high surrogate escape before a character', '{"schema": 1, "documents": ["\\ud83dx.dbs"]}', 'set.json'],
  ['an escaped backslash before u', '{"schema": 1, "documents": ["a\\\\ud800.dbs"]}', 'set.path'],
  ['a key repeated through an escape', '{"schema": 1, "\\u0073chema": 1, "documents": ["shop.dbs"]}', 'set.key'],
  ['a key repeated in a nested object', '{"schema": {"a": 1, "a": 2}, "documents": ["shop.dbs"]}', 'set.key'],
  ['the same key in two nested objects', '{"schema": 1, "documents": ["shop.dbs"], "x": [{"a": 1}, {"a": 1}]}', 'set.key'],
  ['a string value equal to a key', '{"schema": 1, "documents": ["schema"]}', 'set.path'],
  ['schema -1', '{"schema": -1, "documents": ["shop.dbs"]}', 'set.schema'],
  ['schema 10e-1', '{"schema": 10e-1, "documents": ["shop.dbs"]}', null],
  ['schema 1.0000000000000000001, a double of 1', '{"schema": 1.0000000000000000001, "documents": ["shop.dbs"]}', null],
  ['schema NaN', '{"schema": NaN, "documents": ["shop.dbs"]}', 'set.json'],
  ['schema Infinity', '{"schema": Infinity, "documents": ["shop.dbs"]}', 'set.json'],
  ['a lone surrogate before a repeated key', '{"schema": 1, "schema": 1, "documents": ["\\ud800.dbs"]}', 'set.json'],
  ['schema null', '{"schema": null, "documents": ["shop.dbs"]}', 'set.schema'],
  ['documents null', '{"schema": 1, "documents": null}', 'set.key'],
  ['external of a number', '{"schema": 1, "documents": ["shop.dbs"], "external": [1]}', 'set.key'],
  ['external leading dot-dots', '{"schema": 1, "documents": ["shop.dbs"], "external": ["../../a/b.dbs"]}', null],
  ['external of only dot-dots', '{"schema": 1, "documents": ["shop.dbs"], "external": [".."]}', 'set.path'],
  ['a last segment .dbs', '{"schema": 1, "documents": [".dbs"]}', null],
  ['a device with an upper superscript', '{"schema": 1, "documents": ["lpt\\u00b3.dbs"]}', 'set.path'],
  ['COM10 is no device', '{"schema": 1, "documents": ["COM10.dbs"]}', null],
  ['a device as a directory', '{"schema": 1, "documents": ["aux/x.dbs"]}', 'set.path'],
  ['a colon', '{"schema": 1, "documents": ["a:b.dbs"]}', 'set.path'],
  ['U+001F', '{"schema": 1, "documents": ["a\\u001fb.dbs"]}', 'set.path'],
  ['NUL', '{"schema": 1, "documents": ["a\\u0000b.dbs"]}', 'set.path'],
  ['an empty path', '{"schema": 1, "documents": [""]}', 'set.path'],
  ['an empty set file', '', 'set.json'],
];
for (const [name, text, rule] of edges) {
  caseTest(`set-files edge ${name}`, TIMEOUT, () => {
    const result = browserParseSet(new TextEncoder().encode(text), 'app/dbspec-set.json');
    assert.deepEqual(result.errors.map(e => e.rule), rule === null ? [] : [rule]);
  });
}

caseTest('set-files edge unknown keys in code-point order', TIMEOUT, () => {
  const result = browserParseSet(new TextEncoder().encode('{"\\uffff": 1, "\\ud83d\\ude00": 1, "b": 1, "schema": 1, "documents": ["a.dbs"]}'), 'dbspec-set.json');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /"b", "￿", "\u{1f600}"/u);
});

caseTest('set-files edge the joined path keeps the written path and an empty prefix', TIMEOUT, () => {
  const result = browserParseSet(new TextEncoder().encode('{"schema": 1, "documents": ["a.dbs"], "external": ["../b/c.dbs"]}'), 'dbspec-set.json');
  assert.deepEqual([...result.documents, ...result.external].map(p => [p.written, p.path]), [['a.dbs', 'a.dbs'], ['../b/c.dbs', '../b/c.dbs']]);
});

caseTest('set-files edge a set path relative to the working directory', TIMEOUT, () => {
  const root = build({ 'dbspec-set.json': { file: '{"schema": 1, "documents": ["a.dbs"]}' }, 'a.dbs': { file: 'dbspec 1 a\n' } });
  const cwd = process.cwd();
  try {
    process.chdir(root);
    const result = readDbspecSet('dbspec-set.json');
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.documents.map(f => f.path), ['a.dbs']);
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});
