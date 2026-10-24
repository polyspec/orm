import { DatabaseSync } from 'node:sqlite';
import { connect } from '../dist/models/complex_query/models.js';
import { caseTest, DATABASE } from '../../../tests/testcase.mts';
import { mysqlConnection, postgresClient, withCaseDatabase } from './case-database.mjs';
import { fixture, assertSearchCase } from './complex-query-support.mjs';

async function seed(database, dialect) {
  let connection;
  let close;
  if (dialect === 'mysql') {
    connection = await mysqlConnection(database.dsn);
    close = () => connection.end();
  } else if (dialect === 'postgres') {
    connection = postgresClient(database.dsn);
    await connection.connect();
    close = () => connection.end();
  } else {
    connection = new DatabaseSync(database.path);
    close = () => connection.close();
  }
  try {
    for (const table of fixture.seed_order) {
      const columns = fixture.seed_columns[table];
      for (const row of fixture.seed[table]) {
        const values = columns.map(column => {
          if (!(column in row)) throw new Error(`seed ${table} omits column ${column}`);
          return row[column];
        });
        const marks = columns.map((_, i) => dialect === 'postgres' ? `$${i + 1}` : '?');
        const quote = dialect === 'mysql' ? name => `\`${name}\`` : name => `"${name}"`;
        const sql = `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES (${marks.join(', ')})`;
        if (dialect === 'postgres') await connection.query(sql, values);
        else if (dialect === 'mysql') await connection.execute(sql, values);
        else connection.prepare(sql).run(...values);
      }
    }
    if (dialect === 'mysql') {
      for (const sql of fixture.mysql_setup) await connection.execute(sql);
    }
  } finally {
    await close();
  }
}

for (const dialect of ['mysql', 'postgres', 'sqlite']) caseTest(`complex_query_product_search/${dialect}`, DATABASE, async ({ step }) => {
  await withCaseDatabase(dialect, step, async database => {
    const db = await connect(database.dsn);
    try {
      await db.utils().schema().install();
      if (dialect !== 'sqlite') await seed(database, dialect);
      await assertSearchCase(assert, db, dialect);
    } finally {
      await db.close();
    }
  });
});
