// dbspec introspection round trips on MySQL, PostgreSQL and SQLite (docs/dialects.md "Introspection"): every case of
// tests/dbspec/ddl.json and every schema document is rendered, applied to an empty database, schema or file and
// introspected: the schema text of the result equals the schema text of the source with its tables in name order,
// nothing is unsupported, and every set takes the same number of catalog queries per dialect. Introspection rejects an
// unknown dialect and reports a failing catalog query.
//
// Usage: ORM_TEST_MYSQL_DSN=... ORM_TEST_POSTGRES_DSN=... node --test packages/ts/tests/dbspec-introspect-round-trip.mjs (after the build)
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { dbspecManifest, introspectDbspec, renderDbspec } from '../dist/dbspec/index.js';
import { CONNECTION_RULES, DIALECTS, QUERIES, counting, expectedSchemaText, parseSet, roundTripSets, vector, withDatabase } from './introspect_case.mjs';

const sets = roundTripSets();
assert(sets.length > 0, 'round-trip sets');
const queries = { mysql: new Map(), postgres: new Map(), sqlite: new Map() };

for (const s of sets) {
  for (const dialect of DIALECTS) {
    vector(`${dialect}.introspect.${s.id}`, async () => {
      const documents = parseSet(s.id, s.documents);
      const want = expectedSchemaText(documents);
      const rendered = renderDbspec(documents, dialect);
      assert.deepEqual(rendered.diagnostics, []);
      await withDatabase(dialect, async (connection, exec) => {
        for (const sql of [...CONNECTION_RULES[dialect], ...rendered.statements]) await exec(connection, sql);
        const { proxy, counter } = counting(dialect, connection);
        const { document, unsupported } = await introspectDbspec(proxy, dialect, 'introspected');
        const ids = queries[dialect].get(counter.count) ?? [];
        ids.push(`${s.id} (${document.tables.length} tables)`);
        queries[dialect].set(counter.count, ids);
        assert.deepEqual(unsupported, [], 'unsupported objects');
        const manifest = dbspecManifest([document]);
        assert.deepEqual(manifest.diagnostics, []);
        assert.equal(manifest.manifest.schemaText, want);
      });
    });
  }
}

vector('introspection query count per dialect', () => {
  for (const dialect of DIALECTS) {
    const counts = queries[dialect];
    assert.equal(counts.size, 1, `${dialect}: introspection query counts differ between sets: ${JSON.stringify([...counts])}`);
    const [[count, ids]] = counts;
    assert.equal(ids.length, sets.length, `${dialect}: every set is introspected`);
    assert.equal(count, QUERIES[dialect], `${dialect}: query count`);
    console.log(`${dialect}: ${count} queries for every one of ${ids.length} sets`);
  }
});

vector('introspection rejects an unknown dialect', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    await assert.rejects(introspectDbspec(db, 'oracle', 'introspected'), { name: 'TypeError', message: /oracle/ });
  } finally {
    db.close();
  }
});

vector('introspection reports a failing catalog query', async () => {
  const db = new DatabaseSync(':memory:');
  db.close();
  await assert.rejects(introspectDbspec(db, 'sqlite', 'introspected'), { message: /not open/ });
});
