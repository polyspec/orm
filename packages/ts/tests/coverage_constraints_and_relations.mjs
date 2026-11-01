// constraints_and_relations coverage: an immutable table refuses an update, and the refusal changes no row. The foreign key,
// check, unique and relation cases run from contracts/fixtures/constraints_and_relations (constraints-and-relations-check).
import assert from 'node:assert/strict';
import { CORE, OrmError, connect } from '../dist/index.js';
import { nativeQuery, runCases, tableExists } from './coverage_case.mjs';
import { loadDatabaseCaseFixture } from './database-case-fixture.mjs';
import { schemaOf } from './schema_of.mjs';

const refusal = await loadDatabaseCaseFixture('refusal.dbs', 'refused_row');

await runCases('coverage_constraints_and_relations.mjs', {
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
