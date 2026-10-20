// The DSN parameters of the TypeScript client and the MySQL TLS connection (docs/spec/config.md): the DSN uses only the scheme's
// parameters, and `ssl-mode=VERIFY_IDENTITY` with an absolute path `ssl-ca` is the only MySQL TLS
// mode; any other parameter or mode is CONFIG. The connection cases use the DSNs of `make orm-test-servers`:
// ORM_TEST_MYSQL_TLS_DSN, ORM_TEST_MYSQL_TLS_OTHER_CA_DSN, and ORM_TEST_MYSQL_TLS_MISMATCH_DSN
// are required, and the test fails if any of them is missing.
// Usage: node packages/ts/tests/mysql_tls.mjs
import { readFile } from 'node:fs/promises';
import { Db } from '../dist/index.js';
import { parseDsn } from '../dist/driver.js';
import { caseTest, COMPUTE, DATABASE } from '../../../tests/testcase.mts';

// Each case collects its failures and reports them as one error at the end of the case.
function check(failures) {
  if (failures.length > 0) throw new Error(failures.join('; '));
}

// A parameter case is a parse in memory.
// Requirements: CFG-16, CFG-17, CFG-18, CFG-19.
caseTest('mysql_tls/parameters', COMPUTE, () => {
  const failures = [];
  const refused = (dsn, wanted) => {
    try {
      parseDsn(dsn);
      failures.push(`accepted ${dsn}`);
    } catch (error) {
      if (error?.code !== 'CONFIG' || !String(error.message).includes(wanted)) failures.push(`${dsn}: ${error?.code} ${error?.message}, expected CONFIG with ${wanted}`);
    }
  };
  refused('mysql://root@127.0.0.1/orm_example?charset=latin1', 'unknown parameter charset');
  refused('mysql://root@127.0.0.1/orm_example?sslmode=disable', 'unknown parameter sslmode');
  refused('postgres://root@127.0.0.1/orm_example?application_name=orm', 'unknown parameter application_name');
  refused('postgres://root@127.0.0.1/orm_example?ssl-mode=VERIFY_IDENTITY', 'unknown parameter ssl-mode');
  refused('sqlite:///tmp/orm-tls.sqlite?cache=shared', 'unknown parameter cache');
  for (const mode of ['VERIFY_CA', 'REQUIRED', 'PREFERRED', 'DISABLED', 'verify_identity', '']) {
    refused(`mysql://root@db.local/orm_example?ssl-mode=${mode}&ssl-ca=/tmp/ca.pem`, 'ssl-mode');
  }
  refused('mysql://root@db.local/orm_example?ssl-mode=VERIFY_IDENTITY', 'ssl-ca');
  refused('mysql://root@db.local/orm_example?ssl-mode=VERIFY_IDENTITY&ssl-ca=ca.pem', 'absolute');
  refused('mysql://root@db.local/orm_example?ssl-ca=/tmp/ca.pem', 'ssl-mode');
  for (const host of ['127.0.0.1', '[::1]']) refused(`mysql://root@${host}/orm_example?ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem`, 'host name');
  refused('mysql://root@localhost/orm_example?socket=/tmp/mysql.sock&ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem', 'socket');
  const parsed = parseDsn('mysql://root@db.local/orm_example?timezone=UTC&ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem');
  if (parsed.driver !== 'mysql' || parsed.sslCa !== '/tmp/ca.pem') failures.push(`parsed ${JSON.stringify(parsed)}`);
  for (const dsn of ['postgres://orm@127.0.0.1/orm_example?sslmode=disable&timezone=UTC', 'postgres:///orm_example?host=/tmp', 'sqlite:///tmp/orm-tls.sqlite?_pragma=busy_timeout(5000)&timezone=UTC',
    'mysql://root@localhost/orm_example?socket=/tmp/mysql.sock&timezone=UTC']) {
    try { parseDsn(dsn); } catch (error) { failures.push(`refused ${dsn}: ${error?.message}`); }
  }
  check(failures);
});

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
