// What only TypeScript has of the set reader (DBS-176), beside the recipe tests/dbspec/set-files.json that every runtime runs: parseSet takes
// a Uint8Array and a string and decides each case of the recipe without a file tree. A set path in the working directory (DBS-12) is the unit
// dbspec-set-path-in-the-working-directory of every runtime.
// Requirements: DBS-12, DBS-176.
//
// Usage: node --test packages/ts/tests/dbspec-set-edges.mjs (after the build)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseTest } from '../../../../tests/testcase.mts';
import { checkSetMessage } from './recipe.mjs';
import { parseSet, readDbspecSet } from '../dist/dbspec/index.js';
import { parseSet as browserParseSet } from '../dist/dbspec/entry.js';

const TIMEOUT = 15000;

// DBS-176: the TypeScript package validates parseSet(bytes, path) inputs before parsing without reading a file.
caseTest('set-files parseSet takes a Uint8Array and a string', TIMEOUT, () => {
  assert.throws(() => browserParseSet('{}', 'dbspec-set.json'), TypeError);
  assert.throws(() => browserParseSet(new Uint8Array(), 1), TypeError);
  assert.throws(() => readDbspecSet(1), TypeError);
});

// The cases of the recipe tests/dbspec/set-files.json through parseSet, a call that only TypeScript has (DBS-176): a case that needs
// no file tree is rejected by parseSet of both entries, and an accepting case gives no error and the joined paths of the reader.
const SET_NAME = 'dbspec-set.json';
// The rules that parseSet decides from the bytes and the path alone, without a file tree.
const PARSE_RULES = new Set(['set.json', 'set.schema', 'set.key', 'set.empty', 'set.path']);
const recipe = JSON.parse(readFileSync(fileURLToPath(new URL('../../../tests/dbspec/set-files.json', import.meta.url)), 'utf8'));
const cases = recipe.cases.map(({ id, steps: [step] }) => ({ id, tree: step.tree, set: step.set_file, want: step.expect.none }));

/** The bytes that the tree entry at `path` holds, following hard links, and the file that a path below a symbolic link to a directory reaches. */
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

/** Whether parseSet decides the case without a file tree: every error is a rule that it decides, or its set path has another name. */
function needsNoTree(c) {
  if (!('errors' in c.want)) return false;
  if (posix.basename(c.set) !== SET_NAME) return c.want.errors.every(e => e.rule === 'set.file' && e.path === c.set);
  return c.want.errors.every(e => PARSE_RULES.has(e.rule));
}

assert.ok(cases.some(needsNoTree), 'some cases need no file tree');
for (const c of cases) {
  if (needsNoTree(c)) {
    caseTest(`set-files parseSet ${c.id}`, TIMEOUT, () => {
      for (const [entry, parse] of [['node', parseSet], ['browser', browserParseSet]]) {
        const result = parse(new Uint8Array(treeBytes(c.tree, c.set)), c.set);
        assert.deepEqual(result.errors.map(e => ({ rule: e.rule, path: e.path })), c.want.errors.map(e => ({ rule: e.rule, path: e.path })), entry);
        result.errors.forEach((e, i) => {
          assert.deepEqual(Object.keys(e).sort(), ['message', 'path', 'rule']);
          checkSetMessage(e.message, c.want.errors[i], i);
        });
      }
    });
  } else if (!('errors' in c.want)) {
    caseTest(`set-files parseSet ${c.id}`, TIMEOUT, () => {
      const result = browserParseSet(new Uint8Array(treeBytes(c.tree, c.set)), c.set);
      assert.deepEqual(result.errors, []);
      for (const list of ['documents', 'external']) {
        assert.deepEqual(result[list].map(p => p.path), c.want[list], `${list} paths`);
        for (const p of result[list]) assert.equal(p.error, null);
      }
    });
  }
}

caseTest('set-files edge the joined path keeps the written path and an empty prefix', TIMEOUT, () => {
  const result = browserParseSet(new TextEncoder().encode('{"schema": 1, "documents": ["a.dbs"], "external": ["../b/c.dbs"]}'), 'dbspec-set.json');
  assert.deepEqual([...result.documents, ...result.external].map(p => [p.written, p.path]), [['a.dbs', 'a.dbs'], ['../b/c.dbs', '../b/c.dbs']]);
});

caseTest('set-files edge a set path relative to the working directory', TIMEOUT, () => {
  const root = mkdtempSync(join(tmpdir(), 'orm-ts-set-'));
  writeFileSync(join(root, 'dbspec-set.json'), '{"schema": 1, "documents": ["a.dbs"]}', 'utf8');
  writeFileSync(join(root, 'a.dbs'), 'dbspec 1 a\n', 'utf8');
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
