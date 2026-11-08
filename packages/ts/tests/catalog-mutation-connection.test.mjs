// Requirements: INT-106d.
// Runtime-unique (FCV-14): which connection a mutation takes is a choice of each runtime's pool, and the spec names only its fresh transaction.
import assert from 'node:assert/strict';
import { caseTest, DATABASE } from '../../../tests/testcase.mts';
import { connectCatalog } from '../dist/catalog.js';
import { openDriver, parseDsn } from '../dist/driver.js';

const noted = () => {};

/** Inserts rows and reads which server connection wrote each, through a column whose default is the id of that connection. */
async function writers(dsn, create, table) {
  const admin = openDriver(dsn, parseDsn(dsn), { size: 1, idleSize: 1, lifetimeMs: 0 }, 256, 0, true);
  const catalog = await connectCatalog(dsn);
  try {
    await admin.execute(`DROP TABLE IF EXISTS ${table}`, [], undefined, noted);
    await admin.execute(create, [], undefined, noted);
    const namespace = await catalog.currentNamespace();
    const declared = await catalog.describeTable({ namespace, name: table });
    const insert = id => catalog.insertRow(declared, [{ name: 'id', value: id }]);
    for (const id of [1, 2, 3, 4, 5]) await insert(id);
    // A refused insert rolls back and discards its connection, and the next one still writes in a transaction of its own.
    await assert.rejects(insert(1), error => error.code === 'ROW_CONFLICT');
    await insert(7);
    const committed = await admin.execute(`SELECT COUNT(*) FROM ${table}`, [], undefined, noted);
    assert.equal(Number(committed.rows[0][0]), 6);
    const rows = await admin.execute(`SELECT backend FROM ${table} WHERE id < 7`, [], undefined, noted);
    await admin.execute(`DROP TABLE ${table}`, [], undefined, noted);
    return rows.rows.map(row => String(row[0]));
  } finally {
    await catalog.close();
    await admin.close();
  }
}

for (const [database, variable, column] of [
  ['postgres', 'ORM_TEST_POSTGRES_DSN', 'INTEGER NOT NULL DEFAULT pg_backend_pid()'],
  ['mysql', 'ORM_TEST_MYSQL_DSN', 'BIGINT NOT NULL DEFAULT (CONNECTION_ID())'],
]) {
  caseTest(`committed catalog mutations share one connection on ${database}`, DATABASE, async () => {
    const dsn = process.env[variable];
    assert.ok(dsn, `${variable} is required; run make orm-test-servers`);
    const table = `orm_mutation_connection_${process.pid}`;
    const written = await writers(dsn, `CREATE TABLE ${table}(id BIGINT PRIMARY KEY, backend ${column})`, table);
    assert.equal(written.length, 5);
    assert.equal(new Set(written).size, 1, `writers: ${written.join(' ')}`);
  });
}
