// A SQLite-memory owner case for DIA-198. It observes query() calls made by the TypeScript introspector itself.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { introspectDbspec } from '../dist/dbspec/index.js';

// Requirements: DIA-198.
caseTest('SQLite memory catalog query count is independent of table count', COMPUTE, async () => {
  for (const tableCount of [1, 5]) {
    const connection = new DatabaseSync(':memory:');
    try {
      for (let i = 0; i < tableCount; i++) {
        connection.exec(`CREATE TABLE "item_${i}" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "label" TEXT NULL)`);
      }
      let queries = 0;
      const observed = new Proxy(connection, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property !== 'prepare' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value;
          return (...args) => {
            queries++;
            return value.apply(target, args);
          };
        },
      });
      const result = await introspectDbspec(observed, 'sqlite', 'introspected');
      assert.deepEqual(result.unsupported, []);
      assert.equal(result.document.tables.length, tableCount);
      assert.equal(queries, 3, `${tableCount} tables: catalog query count`);
    } finally {
      connection.close();
    }
  }
});

// Requirements: DIA-191.
caseTest('dbspec.introspect.sqlite-empty-check-reason', COMPUTE, async () => {
  const connection = new DatabaseSync(':memory:');
  try {
    connection.exec('CREATE TABLE "probe" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "junk" INTEGER NULL)');
    const result = await introspectDbspec(connection, 'sqlite', 'introspected');
    assert.deepEqual(
      result.unsupported.filter(item => item.name === 'junk').map(item => item.reason),
      ['declared type INTEGER with CHECK "" has no dbspec type'],
    );
  } finally {
    connection.close();
  }
});
