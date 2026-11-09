import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { CatalogConnection } from '../dist/catalog.js';
import { OrmError } from '../dist/runtime_error.js';

const descriptor = {
  table: { namespace: 'main', name: 'page_probe' },
  kind: 'table',
  columns: [{ name: 'id', nativeType: 'INTEGER', nullable: false, generated: false, automaticKey: false, defaultExpression: null, expressionDefault: false, checkPrecision: null }],
  primaryKey: ['id'],
  reliableRowIdentity: true,
};

// Requirements: INT-121. What no server can answer: a statement names its columns in the select list, and a server answers
// with those names.
caseTest('tablePage refuses prepared columns that differ from the descriptor', COMPUTE, async () => {
  const session = {
    async describe() { return descriptor; },
    async collect() { return { columns: [{ name: 'renamed' }], rows: [] }; },
  };
  const catalog = new CatalogConnection('sqlite', {});
  catalog.read = async work => work(session);
  await assert.rejects(
    catalog.tablePage(descriptor.table, 1, 0),
    error => error instanceof OrmError && error.code === 'TABLE_PAGE_METADATA_CHANGED',
  );
});

/**
 * A catalog over a driver that answers every statement of a read session and streams one row of the given columns and values for the
 * query: the seam where a driver hands the catalog its values, which no server can be made to send malformed (FCV-2).
 */
function injected(dialect, columns, values) {
  const answer = { rows: [], affected: 0, insertId: null, columns: [] };
  const session = {
    async control() { return answer; },
    async scan(_sql, _params, sink) {
      sink.columns(columns);
      sink.row(values);
    },
    release() {},
  };
  return new CatalogConnection(dialect, { name: dialect, async reserve() { return session; }, async close() {} });
}

// Requirements: INT-165, INT-171. A driver value that is not the host form of a value of its column type: no driver sends one, so the
// driver seam injects it, and the refusal names its column by its position.
for (const [name, dialect, type, value] of [
  ['a host type that the conversion does not take', 'mysql', 'INT', { value: 1 }],
  ['integer text that is not digits', 'postgres', 'INT8', '12a'],
  ['an integer past the signed 64-bit range', 'mysql', 'BIGINT', '9223372036854775808'],
  ['a negative integer of an unsigned column', 'mysql', 'BIGINT UNSIGNED', '-1'],
  ['float text that is not a number', 'postgres', 'FLOAT8', 'one'],
  ['a single-precision float that arrives as a number', 'mysql', 'FLOAT', 1.5],
  ['a driver date with a time of day', 'postgres', 'DATE', '2020-01-02 03:04:05'],
  ['a driver time with a digit past six fraction digits', 'mysql', 'TIME', '12:34:56.1234567'],
  ['a boolean text that is neither t nor f', 'postgres', 'BOOL', 'yes'],
]) {
  caseTest(`readOnlyGridQuery refuses ${name}`, COMPUTE, async () => {
    const catalog = injected(dialect, [{ name: 'a', type: dialect === 'mysql' ? 'BIGINT' : 'INT8' }, { name: 'b', type }], ['1', value]);
    await assert.rejects(
      catalog.readOnlyGridQuery('SELECT 1, 2', []),
      error => error instanceof OrmError && error.code === 'CATALOG_VALUE' && error.message === 'CATALOG_VALUE: column 2: unsupported driver value',
    );
  });
}

// Requirements: INT-165, INT-172. A PostgreSQL bytea text that is in neither form of bytea_output fails to decode; the refusal names no
// column and keeps the decoder's failure as its cause, in the grid query and in the plain query.
for (const text of ['\\x0', '\\xzz', '\\9', 'café']) {
  caseTest(`the catalog keeps the decode failure of the bytea text ${JSON.stringify(text)} as its cause`, COMPUTE, async () => {
    const decodes = [
      catalog => catalog.readOnlyGridQuery('SELECT 1, 2', []),
      catalog => catalog.readOnlyQuery('SELECT 1, 2', []),
    ];
    for (const read of decodes) {
      await assert.rejects(
        read(injected('postgres', [{ name: 'a', type: 'INT8' }, { name: 'b', type: 'BYTEA' }], ['1', text])),
        error => error instanceof OrmError && error.code === 'CATALOG_VALUE' && error.message === 'CATALOG_VALUE: the driver could not decode the value' &&
          error.cause instanceof TypeError,
      );
    }
  });
}
