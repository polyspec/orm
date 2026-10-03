// TypeScript client의 DSN parameter와 MySQL TLS 연결(docs/config.md): DSN은 scheme의
// parameter만 쓰고, 절대 경로 `ssl-ca`를 둔 `ssl-mode=VERIFY_IDENTITY`가 유일한 MySQL TLS
// mode이며, 다른 parameter와 mode는 모두 CONFIG다. 연결 case는 `make test-servers`의
// ORM_TEST_MYSQL_TLS_DSN, ORM_TEST_MYSQL_TLS_OTHER_CA_DSN, ORM_TEST_MYSQL_TLS_MISMATCH_DSN이
// 필요하며, 하나라도 없으면 실패한다.
// Usage: node clients/typescript/tests/mysql_tls.mjs
import { Db } from '../dist/index.js';
import { parseDsn } from '../dist/driver.js';

const started = performance.now();
const failures = [];
const elapsed = () => `${(performance.now() - started).toFixed(3)}ms`;
// test의 deadline이며, 약 1초인 실행 시간보다 훨씬 길다.
setTimeout(() => { console.log(`TIMEOUT typescript mysql tls ${elapsed()}`); process.exit(1); }, 60_000).unref();

function refused(dsn, wanted) {
  try {
    parseDsn(dsn);
    failures.push(`accepted ${dsn}`);
  } catch (error) {
    if (error?.code !== 'CONFIG' || !String(error.message).includes(wanted)) failures.push(`${dsn}: ${error?.code} ${error?.message}, expected CONFIG with ${wanted}`);
  }
}

console.log('START typescript mysql tls: parameters');
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

async function sslVersion(dsn) {
  const db = await Db.connect(dsn);
  try {
    const [rows] = await db.pool.pool.query("SHOW SESSION STATUS LIKE 'Ssl_version'");
    return rows[0]?.Value ?? '';
  } finally {
    await db.close();
  }
}

console.log('START typescript mysql tls: connections');
const dsns = ['ORM_TEST_MYSQL_TLS_DSN', 'ORM_TEST_MYSQL_TLS_OTHER_CA_DSN', 'ORM_TEST_MYSQL_TLS_MISMATCH_DSN'].map(name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run make test-servers`);
  return value;
});
const version = await sslVersion(dsns[0]);
if (!/^TLSv1\.[23]$/.test(version)) failures.push(`the VERIFY_IDENTITY connection has Ssl_version ${JSON.stringify(version)}`);
for (const [name, dsn] of [['another CA', dsns[1]], ['a certificate of another host', dsns[2]]]) {
  try {
    await sslVersion(dsn);
    failures.push(`the connection with ${name} was accepted`);
  } catch (error) {
    if (!/certificate|altnames|self-signed|verify/i.test(String(error?.message))) failures.push(`the connection with ${name} failed for another cause: ${error?.message}`);
  }
}

if (failures.length > 0) {
  console.log(`FAIL typescript mysql tls ${elapsed()}`);
  for (const failure of failures) console.log(`  ${failure}`);
  process.exit(1);
}
console.log(`PASS typescript mysql tls ${elapsed()}`);
