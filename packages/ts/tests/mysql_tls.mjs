// The MySQL TLS connection of the TypeScript client (docs/spec/config.md). The refused parameters and modes are cases of
// contracts/fixtures/dsn_reject. The connection cases use the DSNs of `make orm-test-servers`:
// ORM_TEST_MYSQL_TLS_DSN, ORM_TEST_MYSQL_TLS_OTHER_CA_DSN, and ORM_TEST_MYSQL_TLS_MISMATCH_DSN
// are required, and the test fails if any of them is missing.
// Usage: node packages/ts/tests/mysql_tls.mjs
import { readFile } from 'node:fs/promises';
import { Db } from '../dist/index.js';
import { caseTest, DATABASE } from '../../../tests/testcase.mts';

// Each case collects its failures and reports them as one error at the end of the case.
function check(failures) {
  if (failures.length > 0) throw new Error(failures.join('; '));
}

async function sslVersion(dsn) {
  const db = await Db.connect(dsn);
  try {
    const [rows] = await db.pool.pool.query("SHOW SESSION STATUS LIKE 'Ssl_version'");
    return rows[0]?.Value ?? '';
  } finally {
    await db.close();
  }
}

// A connection case connects to the TLS server three times.
// Requirements: CFG-16.
caseTest('mysql_tls/connections', DATABASE, async ({ step }) => {
  const failures = [];
  const dsns = ['ORM_TEST_MYSQL_TLS_DSN', 'ORM_TEST_MYSQL_TLS_OTHER_CA_DSN', 'ORM_TEST_MYSQL_TLS_MISMATCH_DSN'].map(name => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set; run make orm-test-servers`);
    return value;
  });
  const version = await sslVersion(dsns[0]);
  step(`the VERIFY_IDENTITY connection has Ssl_version ${version}`);
  if (!/^TLSv1\.[23]$/.test(version)) failures.push(`the VERIFY_IDENTITY connection has Ssl_version ${JSON.stringify(version)}`);
  for (const [name, dsn] of [['another CA', dsns[1]], ['a certificate of another host', dsns[2]]]) {
    try {
      await sslVersion(dsn);
      failures.push(`the connection with ${name} was accepted`);
    } catch (error) {
      if (!/certificate|altnames|self-signed|verify/i.test(String(error?.message))) failures.push(`the connection with ${name} failed for another cause: ${error?.message}`);
    }
  }
  check(failures);
});
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
