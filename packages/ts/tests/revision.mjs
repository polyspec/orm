// An update or delete with an expected revision (docs/spec/dsl.md "Writes", expectRevision) on a SQLite file of each
// case in a temporary directory that is removed when the case ends: a match updates and bumps the revision or
// deletes, a mismatch fails with REVISION_CHANGED and changes nothing.
//
// Usage: node packages/ts/tests/revision.mjs (after npm run typescript:build)
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest, DATABASE } from '../../../tests/testcase.mts';
import { CORE, Db, Model, OrmError, codes, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';

const parsed = parseDbspec('dbspec 1 revision\n\ntable note {\n  seq i64 identity\n  label varchar(32)\n  revision i64\n  primary key (seq)\n}\n', {});
assert.deepEqual(parsed.diagnostics, [], 'the document parses');
const { manifest } = dbspecManifest([parsed.document]);
const schema = { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
const runtime = registerModel(manifest.manifestText, manifest.manifestHash);
class Note extends Model {}
Note.entity = { model: runtime, entity: runtime.entities.get('note'), create: core => new Note(core) };

function note(values) {
  const m = new Note();
  for (const [column, value] of Object.entries(values)) m[CORE].setValue(column, value);
  return m;
}

async function codeOf(promise) {
  try { await promise; return null; } catch (error) { return error instanceof OrmError ? error.code : String(error); }
}

/** The [label, revision] of every stored note. */
async function stored(db) {
  return (await new Note().connect(db).gets()).values().map(row => [row.toArray().label, Number(row.toArray().revision)]);
}

/** Runs body with a connection to a new SQLite file that holds one note at revision 3, and the note's key. */
async function withNote(body) {
  const dir = await mkdtemp(join(tmpdir(), 'orm-revision-'));
  const db = await Db.connect(`sqlite://${join(dir, 'revision.sqlite')}`);
  try {
    await db.utils().schema().install(schema);
    const row = await note({ label: 'first', revision: 3 }).connect(db).create();
    await body(db, row.toArray().seq);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// The test of DSL-108, DSL-114 (docs/spec).
caseTest('revision/update-match', DATABASE, () => withNote(async (db, seq) => {
  await note({ seq, label: 'second' }).connect(db).expectRevision('revision', 3).update();
  assert.deepEqual(await stored(db), [['second', 4]]);
}));

// The test of DSL-108, DSL-114 (docs/spec).
caseTest('revision/update-mismatch', DATABASE, () => withNote(async (db, seq) => {
  assert.equal(await codeOf(note({ seq, label: 'stale' }).connect(db).expectRevision('revision', 2).update()), codes.REVISION_CHANGED);
  assert.deepEqual(await stored(db), [['first', 3]]);
}));

// The test of DSL-108, DSL-114 (docs/spec).
caseTest('revision/delete-match', DATABASE, () => withNote(async (db, seq) => {
  await note({ seq }).connect(db).expectRevision('revision', 3).delete();
  assert.deepEqual(await stored(db), []);
}));

// The test of DSL-108, DSL-114 (docs/spec).
caseTest('revision/delete-mismatch', DATABASE, () => withNote(async (db, seq) => {
  assert.equal(await codeOf(note({ seq }).connect(db).expectRevision('revision', 4).delete()), codes.REVISION_CHANGED);
  assert.deepEqual(await stored(db), [['first', 3]]);
}));
