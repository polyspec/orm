// resolveSet with the node:fs host of the command line (docs/spec/editor-stack.md ruling 4): the set-files.json
// vectors where a document discovers the case's set file, the nearest ancestor that lists the document, a document
// that two set files list, a document that no set file lists, the set given to openDocument and the diagnostics of the
// set's other files. Every tree is written under a fresh temporary directory with real symbolic and hard links.
//
// Usage: node --test packages/dbspec-language/tests/resolve-set.test.mjs (after the build)
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { parseSet } from '@polyspec/orm/dbspec';
import { caseTest } from '../../../tests/testcase.mts';
import { resolveSet } from '../dist/index.js';
import { nodeSetHost } from '../dist/cli/host.js';
import { repo } from './helpers.mjs';

// The deadline of one case: it writes a tree of a few files and reads it.
const TIMEOUT = 15000;
const vector = (name, body) => caseTest(name, TIMEOUT, body);
const SET_NAME = 'dbspec-set.json';

const vectors = JSON.parse(readFileSync(new URL('tests/dbspec/set-files.json', repo), 'utf8'));

/** A tree root in the `/` form that resolveSet takes: the platform separators become `/`. */
const slashes = path => path.replaceAll('\\', '/');

/** Writes the tree under a new empty temporary directory and returns that directory with `/` separators. */
function build(tree) {
  const root = mkdtempSync(join(tmpdir(), 'dbspec-language-set-'));
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
  return slashes(root);
}

/** Runs body with a tree written under a temporary directory, and removes the directory. */
function withTree(tree, body) {
  const root = build(tree);
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The tree path that `path` names when each directory that is a symbolic link of the tree is followed, as the
 * platform resolves the directories of a path.
 */
function followDirectories(tree, path) {
  const segments = path.split('/');
  let at = '';
  for (const [i, segment] of segments.entries()) {
    at = at === '' ? segment : `${at}/${segment}`;
    const entry = tree[at];
    if (i < segments.length - 1 && entry !== undefined && 'symlink' in entry) at = posix.join(posix.dirname(at), entry.symlink);
  }
  return at;
}

/** The bytes of a tree entry that is a file, following hard links; null for a symbolic link or a missing entry. */
function treeBytes(tree, path) {
  const entry = tree[path];
  if (entry === undefined || 'symlink' in entry) return null;
  if ('file' in entry) return Buffer.from(entry.file, 'utf8');
  if ('hex' in entry) return Buffer.from(entry.hex, 'hex');
  return treeBytes(tree, entry.hardlink);
}

/**
 * The document of a set-files case that resolveSet is called with, relative to the tree root, or the reason the case
 * does not apply. A document discovers only a set file named dbspec-set.json in one of its directories, and a set file
 * lists a document only by a path with the normal form; a file whose name only a case-folding file system resolves
 * to dbspec-set.json is not one. When the set file is not a plain file or its JSON fails,
 * step 1 or 2 fails before any document is compared, so the probe document `probe.dbs` beside it is used.
 */
function documentOf(c) {
  if (posix.basename(c.set) !== SET_NAME) return { reason: 'its set file is not named dbspec-set.json, so no document discovers it' };
  const dir = posix.dirname(c.set);
  const at = written => (dir === '.' ? written : `${dir}/${written}`);
  const file = followDirectories(c.tree, c.set);
  const bytes = treeBytes(c.tree, file);
  if (bytes === null) {
    if (c.tree[file] === undefined) return { reason: 'its set file does not exist, so no document discovers it' };
    return { path: at('probe.dbs') };
  }
  const parsed = parseSet(new Uint8Array(bytes), c.set);
  if (parsed.documents === null) return { path: at('probe.dbs') };
  const listed = parsed.documents.find(p => p.error === null);
  if (listed === undefined) return { reason: 'no documents path has the normal form, so it lists no document' };
  return { path: at(listed.written) };
}

const notApplied = [];
for (const c of vectors.cases) {
  const target = documentOf(c);
  if ('reason' in target) {
    notApplied.push(`${c.id}: ${target.reason}`);
    continue;
  }
  vector(`set-files ${c.id} through resolveSet`, () => withTree(c.tree, root => {
    const result = resolveSet(`${root}/${target.path}`, nodeSetHost);
    if ('errors' in c.want) {
      assert.equal(result.set, null);
      assert.deepEqual(result.errors.map(e => ({ rule: e.rule, path: e.path })), c.want.errors.map(e => ({ rule: e.rule, path: `${root}/${e.path}` })));
      for (const e of result.errors) assert.ok(e.message.includes(e.path), `the message names the path: ${e.message}`);
      return;
    }
    assert.deepEqual(result.errors, []);
    assert.equal(result.setFile, `${root}/${c.set}`);
    // The other listed files: a dbspec text is in the set under its header name, any other bytes are a diagnostic.
    const expected = {};
    const failed = [];
    for (const p of [...c.want.documents, ...c.want.external]) {
      if (p === target.path) continue;
      const text = treeBytes(c.tree, followDirectories(c.tree, posix.normalize(p))).toString('utf8');
      if (text.startsWith('dbspec 1 ')) expected[text.slice('dbspec 1 '.length, text.indexOf('\n'))] = text;
      else failed.push(`${root}/${p}`);
    }
    assert.deepEqual({ ...result.set }, expected);
    assert.deepEqual(result.diagnostics.map(d => d.path), failed);
  }));
}

// The cases that no document can reach through resolveSet are exactly these, each with its reason.
vector('set-files cases that resolveSet does not reach', () => {
  assert.deepEqual(notApplied, [
    'set-file-wrong-name: its set file is not named dbspec-set.json, so no document discovers it',
    'set-file-missing: its set file does not exist, so no document discovers it',
    'set-file-name-case: its set file does not exist, so no document discovers it',
    'path-absolute: no documents path has the normal form, so it lists no document',
    'path-drive: no documents path has the normal form, so it lists no document',
    'path-backslash: no documents path has the normal form, so it lists no document',
    'path-dot: no documents path has the normal form, so it lists no document',
    'path-empty-segment: no documents path has the normal form, so it lists no document',
    'path-trailing-slash: no documents path has the normal form, so it lists no document',
    'path-suffix: no documents path has the normal form, so it lists no document',
    'path-device: no documents path has the normal form, so it lists no document',
    'path-device-before-dots: no documents path has the normal form, so it lists no document',
    'path-device-trailing-space: no documents path has the normal form, so it lists no document',
    'path-device-superscript: no documents path has the normal form, so it lists no document',
    'path-trailing-dot-segment: no documents path has the normal form, so it lists no document',
    'path-trailing-space-segment: no documents path has the normal form, so it lists no document',
    'path-reserved-char: no documents path has the normal form, so it lists no document',
    'path-control-char: no documents path has the normal form, so it lists no document',
    'documents-dotdot: no documents path has the normal form, so it lists no document',
    'documents-inner-dotdot: no documents path has the normal form, so it lists no document',
  ]);
});

const shop = 'dbspec 1 shop\n\ntable item {\n  id i64 identity\n  primary key (id)\n}\n';
const billing = 'dbspec 1 billing\n\nuse shop { item }\n\ntable invoice {\n  id i64 identity\n  item_id i64\n  primary key (id)\n  index ix_invoice_item (item_id)\n  foreign key fk_invoice_item (item_id) references item (id) on delete restrict on update restrict\n}\n';
const core = 'dbspec 1 core\n\ntable account {\n  id i64 identity\n  primary key (id)\n}\n';
const set = (documents, external) => ({ file: JSON.stringify(external === undefined ? { schema: 1, documents } : { schema: 1, documents, external }) });

vector('resolveSet takes the nearest ancestor set file that lists the document', () => withTree({
  'proj/dbspec-set.json': set(['app/shop.dbs', 'app/billing.dbs']),
  'proj/app/dbspec-set.json': set(['other.dbs']),
  'proj/app/other.dbs': { file: core },
  'proj/app/shop.dbs': { file: shop },
  'proj/app/billing.dbs': { file: billing },
}, root => {
  const result = resolveSet(`${root}/proj/app/billing.dbs`, nodeSetHost);
  assert.deepEqual(result, { setFile: `${root}/proj/dbspec-set.json`, set: { shop }, diagnostics: [], errors: [] });
}));

vector('resolveSet stops at the nearest set file that lists the document', () => withTree({
  'proj/dbspec-set.json': set(['shop.dbs']),
  'proj/shop.dbs': { file: shop },
  'proj/app/dbspec-set.json': set(['billing.dbs'], ['../shop.dbs']),
  'proj/app/billing.dbs': { file: billing },
}, root => {
  const result = resolveSet(`${root}/proj/app/billing.dbs`, nodeSetHost);
  assert.deepEqual(result, { setFile: `${root}/proj/app/dbspec-set.json`, set: { shop }, diagnostics: [], errors: [] });
}));

vector('resolveSet gives the owned and the external documents by their header names, without the document', () => withTree({
  'app/dbspec-set.json': set(['shop.dbs', 'billing/billing.dbs'], ['../core/core.dbs']),
  'app/shop.dbs': { file: shop },
  'app/billing/billing.dbs': { file: billing },
  'core/core.dbs': { file: core },
}, root => {
  const result = resolveSet(`${root}/app/billing/billing.dbs`, nodeSetHost);
  assert.deepEqual(result, { setFile: `${root}/app/dbspec-set.json`, set: { shop, core }, diagnostics: [], errors: [] });
}));

vector('a document that two set files list is an error naming both', () => withTree({
  'proj/dbspec-set.json': set(['app/shop.dbs']),
  'proj/app/dbspec-set.json': set(['shop.dbs']),
  'proj/app/shop.dbs': { file: shop },
}, root => {
  const path = `${root}/proj/app/shop.dbs`;
  const result = resolveSet(path, nodeSetHost);
  assert.equal(result.set, null);
  assert.deepEqual(result.errors.map(e => ({ rule: e.rule, path: e.path })), [{ rule: 'set.owner', path }]);
  assert.ok(result.errors[0].message.includes(`${root}/proj/app/dbspec-set.json`) && result.errors[0].message.includes(`${root}/proj/dbspec-set.json`), result.errors[0].message);
}));

vector('an external listing does not make a second owner', () => withTree({
  'proj/dbspec-set.json': set(['other/billing.dbs'], ['../app/shop.dbs']),
  'proj/other/billing.dbs': { file: billing },
  'app/dbspec-set.json': set(['shop.dbs']),
  'app/shop.dbs': { file: shop },
}, root => {
  const result = resolveSet(`${root}/app/shop.dbs`, nodeSetHost);
  assert.deepEqual(result, { setFile: `${root}/app/dbspec-set.json`, set: {}, diagnostics: [], errors: [] });
}));

vector('a document that no set file lists is a set of itself alone', () => withTree({
  'app/shop.dbs': { file: shop },
  'app/dbspec-set.json': set(['other.dbs']),
  'app/other.dbs': { file: core },
}, root => {
  assert.deepEqual(resolveSet(`${root}/app/shop.dbs`, nodeSetHost), { setFile: null, set: {}, diagnostics: [], errors: [] });
}));

vector('a document with no set file above it is a set of itself alone', () => withTree({ 'app/shop.dbs': { file: shop } }, root => {
  assert.deepEqual(resolveSet(`${root}/app/shop.dbs`, nodeSetHost), { setFile: null, set: {}, diagnostics: [], errors: [] });
}));

vector('a file whose name only folds to dbspec-set.json is not a set file', () => withTree({
  'app/DBSPEC-SET.JSON': set(['shop.dbs']),
  'app/shop.dbs': { file: shop },
}, root => {
  assert.deepEqual(resolveSet(`${root}/app/shop.dbs`, nodeSetHost), { setFile: null, set: {}, diagnostics: [], errors: [] });
}));

vector('an ancestor set file that cannot be read is an error, since whether it lists the document is unknown', () => withTree({
  'proj/dbspec-set.json': { file: '{"schema": 1, "documents": [' },
  'proj/app/shop.dbs': { file: shop },
}, root => {
  const result = resolveSet(`${root}/proj/app/shop.dbs`, nodeSetHost);
  assert.equal(result.set, null);
  assert.deepEqual(result.errors.map(e => ({ rule: e.rule, path: e.path })), [{ rule: 'set.json', path: `${root}/proj/dbspec-set.json` }]);
}));

vector('a listed file that fails the byte check is a diagnostic and is not in the set', () => withTree({
  'app/dbspec-set.json': set(['shop.dbs', 'billing.dbs', 'notes.dbs', 'bad.dbs']),
  'app/shop.dbs': { file: shop },
  'app/billing.dbs': { file: billing },
  'app/notes.dbs': { file: 'notes\n' },
  'app/bad.dbs': { hex: Buffer.from('dbspec 1 bad\n\xff').toString('hex').replace('c3bf', 'ff') },
}, root => {
  const result = resolveSet(`${root}/app/billing.dbs`, nodeSetHost);
  assert.deepEqual(result.errors, []);
  assert.deepEqual({ ...result.set }, { shop });
  assert.deepEqual(result.diagnostics.map(d => [d.path, d.line, d.column, d.rule]), [
    [`${root}/app/notes.dbs`, 1, 1, 'signature'],
    [`${root}/app/bad.dbs`, 2, 1, 'encoding'],
  ]);
}));

vector('a listed file whose header has no name is a diagnostic and is not in the set', () => withTree({
  'app/dbspec-set.json': set(['shop.dbs', 'billing.dbs']),
  'app/shop.dbs': { file: 'dbspec 2 shop\n' },
  'app/billing.dbs': { file: billing },
}, root => {
  const result = resolveSet(`${root}/app/billing.dbs`, nodeSetHost);
  assert.deepEqual(result.errors, []);
  assert.deepEqual({ ...result.set }, {});
  assert.deepEqual(result.diagnostics.map(d => [d.path, d.line, d.rule]), [[`${root}/app/shop.dbs`, 1, 'header']]);
}));

vector('resolveSet takes an absolute path in normal form', () => {
  for (const path of ['app/shop.dbs', './shop.dbs', '/a/../shop.dbs', '/a//shop.dbs', '/a/./shop.dbs', '/', 'C:shop.dbs', 1]) {
    assert.throws(() => resolveSet(path, nodeSetHost), TypeError, String(path));
  }
});
