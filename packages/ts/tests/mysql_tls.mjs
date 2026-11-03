// The session sql_mode of the TypeScript client. The MySQL TLS connection and its refusals are cases of
// contracts/fixtures/dsn_connection and contracts/fixtures/dsn_reject.
// Usage: node packages/ts/tests/mysql_tls.mjs
import { readFile } from 'node:fs/promises';
import { Db } from '../dist/index.js';
import { caseTest, DATABASE } from '../../../tests/testcase.mts';

// The session sql_mode that the client sets on every MySQL connection equals sql_mode.session of
// tests/dsn/mysql-session.json, not the server default (docs/spec/config.md "Runtime connection").
// Requirements: CFG-3.
caseTest('mysql_tls/session_sql_mode', DATABASE, async ({ step }) => {
  const dsn = process.env.ORM_TEST_MYSQL_DSN;
  if (!dsn) throw new Error('ORM_TEST_MYSQL_DSN is not set; run make orm-test-servers');
  const vector = JSON.parse(await readFile(new URL('../../../tests/dsn/mysql-session.json', import.meta.url), 'utf8'));
  const db = await Db.connect(dsn);
  try {
    const [rows] = await db.pool.pool.query('SELECT @@SESSION.sql_mode AS mode');
    const mode = rows[0]?.mode ?? '';
    step(`@@SESSION.sql_mode is ${mode}`);
    if (mode !== vector.sql_mode.session) throw new Error(`@@SESSION.sql_mode is ${JSON.stringify(mode)}, expected ${JSON.stringify(vector.sql_mode.session)}`);
  } finally {
    await db.close();
  }
});
