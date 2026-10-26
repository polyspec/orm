// The MySQL reader of a SHOW CREATE TABLE statement (createChecks of src/dbspec/introspect_mysql.ts, T62-4-8)
// reads every case of tests/dbspec/show-create.json to the body that the case expects in CHECK_CLAUSE form, or
// to no body for a name the statement does not have.
//
// Usage: node --test packages/ts/tests/dbspec-show-create.mjs (after the build)
import { caseTest } from '../../../tests/testcase.mts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChecks } from '../dist/dbspec/introspect_mysql.js';
import { emitDbspec, introspectDbspec } from '../dist/dbspec/index.js';

// TIMEOUT is the deadline (ms) of one case. It is a computation that reads one string.
const TIMEOUT = 60000;
const data = JSON.parse(readFileSync(new URL('../../../tests/dbspec/show-create.json', import.meta.url), 'utf8'));

for (const c of data.cases) {
  // Requirements: DIA-84.
  caseTest(c.id, TIMEOUT, () => {
    const checks = createChecks(c.create.join('\n') + '\n');
    const got = checks.get(c.name);
    if (c.expected === 'not found') {
      assert.equal(got, undefined, `${c.name} is read as ${JSON.stringify(got)}, want not found`);
      return;
    }
    assert.equal(got, c.expected, `${c.name} is read as ${JSON.stringify(got)}`);
  });
}

function cannedRows(sql, catalog, vector) {
  if (sql.includes('information_schema.TABLES')) {
    return [[catalog.table, 'BASE TABLE', '']];
  }
  if (sql.includes('information_schema.COLUMNS')) {
    return catalog.columns.map(column => [
      catalog.table,
      column.name,
      column.type,
      column.nullable,
      null,
      '',
      column.charset,
      column.collation,
      '',
    ]);
  }
  if (sql.includes('information_schema.STATISTICS')) {
    return [[catalog.table, 'PRIMARY', 0, catalog.primary_key, 'A', 0, 0, 'BTREE']];
  }
  if (sql.includes('REFERENTIAL_CONSTRAINTS')) return [];
  if (sql.includes('information_schema.CHECK_CONSTRAINTS')) {
    return [[vector.name, catalog.stored_clause]];
  }
  if (sql.includes('information_schema.TABLE_CONSTRAINTS')) {
    return [[catalog.table, vector.name, 'YES']];
  }
  if (sql.includes('SHOW CREATE TABLE')) {
    return [[catalog.table, vector.create.join('\n') + '\n']];
  }
  if (
    sql.includes('information_schema.TRIGGERS') ||
    sql.includes('information_schema.ROUTINES') ||
    sql.includes('information_schema.EVENTS')
  ) {
    return [];
  }
  throw new Error(`no canned answer for ${sql}`);
}

async function introspectCase(c) {
  const catalog = data.catalog;
  const connection = { query: async ({ sql }) => [cannedRows(sql, catalog, c)] };
  if (c.error !== undefined) {
    await assert.rejects(
      introspectDbspec(connection, 'mysql', 'introspected'),
      error => error.message === c.error,
    );
    return;
  }
  const result = await introspectDbspec(connection, 'mysql', 'introspected');
  const checks = emitDbspec(result.document)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('check '));
  const unsupported = result.unsupported.map(
    u => `${u.kind} ${u.name}: ${u.reason.split(': ', 1)[0]}`,
  );
  assert.deepEqual(checks, c.checks, 'introspected checks');
  assert.deepEqual(unsupported, c.unsupported, 'introspected unsupported objects');
}

for (const c of data.cases) {
  // Requirements: DIA-84. The public introspection path must preserve each SHOW CREATE check body.
  caseTest(`introspection/${c.id}`, TIMEOUT, () => introspectCase(c));
}
