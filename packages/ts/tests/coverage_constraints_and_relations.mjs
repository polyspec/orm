// constraints_and_relations coverage: each foreign key, check, and unique violation that the database rejects
// is reported as FOREIGN_KEY, CONSTRAINT, or DUPLICATE_KEY, and no row changes.
import assert from 'node:assert/strict';
import { CORE, Author, NoteReader, OrmError, SharedNote, User, connect } from '../dist/index.js';
import { errorCode, nativeQuery, runCases, tableExists } from './coverage_case.mjs';
import { loadDatabaseCaseFixture } from './database-case-fixture.mjs';
import { schemaOf } from './schema_of.mjs';

const refusal = await loadDatabaseCaseFixture('refusal.dbs', 'refused_row');

await runCases('coverage_constraints_and_relations.mjs', {
  // CFG-33: a violated foreign key, check or unique key is reported as FOREIGN_KEY, CONSTRAINT or DUPLICATE_KEY, and no row changes.
  async constraint_errors({ driver, dsn }) {
    const db = await connect(dsn, { aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index' });
    try {
      assert.equal(db.driver, driver);
      const snapshot = async () => {
        const first = await new Author().connect(db).addAllColumns().getBySeq(1);
        const user = await new User().connect(db).getBySeq(1);
        return { author: first.toJSONText(), user: user.toJSONText() };
      };
      const before = await snapshot();
      const second = await new Author().connect(db).getBySeq(2);
      assert.equal(typeof second.getUuid(), 'string', 'author 2 has a uuid');

      const user = await new User().connect(db).getBySeq(1);
      assert.equal(await errorCode(user.delete()), 'FOREIGN_KEY', 'delete of a referenced user');
      assert.equal(await errorCode(new Author().connect(db).setSeq(1).setLikeCount(-1).update()), 'CONSTRAINT', 'ck_author_counts');
      assert.equal(await errorCode(new Author().connect(db).setSeq(1).setUuid(second.getUuid()).update()), 'DUPLICATE_KEY', 'uq_author_uuid');
      assert.deepEqual(await snapshot(), before, 'the rejected writes changed nothing');
    } finally { await db.close(); }
  },
  async external_relation({ driver, dsn }) {
    const db = await connect(dsn, { aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index' });
    try {
      assert.equal(db.driver, driver);
      const rows = await new NoteReader().connect(db)
        .relation(new SharedNote().matchSharedNoteSeqWithSeq())
        .orderBySeqAsc()
        .gets();
      const got = rows.values().map(row => `${row.getSeq()}:${row.getSharedNoteModel()?.getTitle()}`);
      assert.deepEqual(got, ['1:note-1', '2:note-1', '3:note-3'], 'relation reads the external shared_note document');
    } finally { await db.close(); }
  },
  async immutable_write({ driver, dsn }) {
    // Requirements: DBS-84.
    assert.equal(await tableExists(driver, dsn, 'refused_row'), false, 'refusal table is absent before the case');
    const db = await connect(dsn);
    const quote = name => driver === 'mysql' ? `\`${name}\`` : `"${name}"`;
    try {
      await db.utils().schema().install(schemaOf(refusal.text));
      const created = new refusal.model().connect(db);
      created[CORE].setValue('amount', 1);
      const row = await created.create();
      const seq = row[CORE].column('seq');
      const changed = new refusal.model().connect(db);
      changed[CORE].setValue('seq', seq);
      changed[CORE].setValue('amount', 2);
      let error;
      try { await changed.update(); } catch (caught) { error = caught; }
      assert(error instanceof OrmError, `immutable write error ${error}`);
      assert.equal(error.code, 'DRIVER', 'immutable write error code');
      assert.match(String(error.message), /table refused_row is immutable/, 'immutable write message');
      assert(error.cause !== undefined, 'immutable write keeps the driver cause');
      const [[stored]] = await nativeQuery(driver, dsn, [`SELECT amount FROM ${quote('refused_row')} WHERE seq = ${Number(seq)}`]);
      assert.equal(Number(stored.amount), 1, 'the immutable row was changed');
    } finally {
      const drops = [`DROP TABLE IF EXISTS ${quote('refused_row')}`];
      if (driver === 'postgres') {
        drops.push('DROP FUNCTION IF EXISTS "refused_row$immutable_update"()');
        drops.push('DROP FUNCTION IF EXISTS "refused_row$immutable_delete"()');
      }
      try { await nativeQuery(driver, dsn, drops); } finally { await db.close(); }
    }
    assert.equal(await tableExists(driver, dsn, 'refused_row'), false, 'refusal table is removed after the case');
  },
}, 300_000);
