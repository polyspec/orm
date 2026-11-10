// The driver errors that driverError classifies. Each case builds the error of the driver and needs no database.
//
// Usage: npm run typescript:build && node --test packages/ts/tests/driver-error-lock-wait.mjs
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driverError, mysqlStatementTimeout, openDriver, parseDsn } from '../dist/driver.js';
import { dialectOf } from '../dist/engine/dialect.js';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

// Requirements: PLN-24.
caseTest('driver-error/sqlite-locked/sqlite', COMPUTE, () => {
  const source = Object.assign(new Error('database table is locked'), { code: 'SQLITE_LOCKED', errcode: 6 });
  const mapped = driverError('sqlite', source);
  assert.equal(mapped.code, 'DRIVER');
  assert.notEqual(mapped.code, 'DEADLOCK');
  assert.match(mapped.message, /sqlite: database table is locked/);
});

// Requirements: DIA-201. A mysql error number is read by the table of its server: MySQL's 4025 is an InnoDB option error and
// MariaDB's a failed CHECK, and MySQL's 3572, 3819, 3024 and 4031 name no MariaDB condition.
caseTest('driver-error/number-by-server/mysql', COMPUTE, () => {
  const error = errno => Object.assign(new Error(`error ${errno}`), { errno });
  for (const [errno, mysql, mariadb] of [
    [4025, 'DRIVER', 'CONSTRAINT'], [3819, 'CONSTRAINT', 'DRIVER'], [3572, 'LOCK_NOT_AVAILABLE', 'DRIVER'], [3024, 'CANCELED', 'DRIVER'],
    [4031, 'CONNECTION_LOST', 'DRIVER'], [1969, 'DRIVER', 'CANCELED'], [1062, 'DUPLICATE_KEY', 'DUPLICATE_KEY'], [1452, 'FOREIGN_KEY', 'FOREIGN_KEY'],
    [1213, 'DEADLOCK', 'DEADLOCK'], [1290, 'READ_ONLY', 'READ_ONLY'], [1205, 'CANCELED', 'CANCELED'],
  ]) {
    assert.equal(driverError('mysql', error(errno), 'mysql').code, mysql, `mysql ${errno}`);
    assert.equal(driverError('mysql', error(errno), 'mariadb').code, mariadb, `mariadb ${errno}`);
  }
});

// Requirements: DIA-209. MariaDB fails a NOWAIT lock that it cannot take at once with 1205: a statement of a *_nowait lock reads it
// as LOCK_NOT_AVAILABLE, and any other statement as CANCELED, the lock wait timeout; MySQL's 1205 stays CANCELED, its NOWAIT is 3572.
caseTest('driver-error/nowait-lock-wait/mysql', COMPUTE, () => {
  const error = errno => Object.assign(new Error(`error ${errno}`), { errno });
  assert.equal(driverError('mysql', error(1205), 'mariadb', true).code, 'LOCK_NOT_AVAILABLE');
  assert.equal(driverError('mysql', error(1205), 'mariadb', false).code, 'CANCELED');
  assert.equal(driverError('mysql', error(1205), 'mysql', true).code, 'CANCELED');
  assert.equal(driverError('mysql', error(3572), 'mysql', true).code, 'LOCK_NOT_AVAILABLE');
  assert.equal(driverError('mysql', error(1213), 'mariadb', true).code, 'DEADLOCK');
});

// Requirements: DIA-208. The statement timeout is the variable of the server: max_execution_time in milliseconds on MySQL, and
// max_statement_time in seconds with three fraction digits on MariaDB; neither server has the other's variable.
caseTest('driver-statement-timeout/variable-by-server/mysql', COMPUTE, () => {
  assert.equal(mysqlStatementTimeout('mysql', 237), 'SET SESSION max_execution_time = 237');
  assert.equal(mysqlStatementTimeout('mariadb', 237), 'SET SESSION max_statement_time = 0.237');
  assert.equal(mysqlStatementTimeout('mariadb', 1500), 'SET SESSION max_statement_time = 1.500');
  assert.equal(mysqlStatementTimeout('mariadb', 1), 'SET SESSION max_statement_time = 0.001');
  assert.doesNotMatch(mysqlStatementTimeout('mariadb', 237), /max_execution_time/);
  assert.doesNotMatch(mysqlStatementTimeout('mysql', 237), /max_statement_time/);
});

// Requirements: DIA-209. share renders LOCK IN SHARE MODE on both servers of the mysql dialect and FOR SHARE on PostgreSQL;
// share_nowait renders FOR SHARE NOWAIT on MySQL and LOCK IN SHARE MODE NOWAIT on MariaDB; an unknown mode has no suffix.
caseTest('dialect-row-lock/by-server/mysql', COMPUTE, () => {
  const lock = (name, server, mode) => dialectOf(name, server).rowLock(mode);
  for (const server of ['mysql', 'mariadb']) {
    assert.equal(lock('mysql', server, 'share'), ' LOCK IN SHARE MODE', server);
    assert.equal(lock('mysql', server, 'update'), ' FOR UPDATE', server);
    assert.equal(lock('mysql', server, 'update_nowait'), ' FOR UPDATE NOWAIT', server);
    assert.equal(lock('mysql', server, 'exclusive'), undefined, server);
  }
  assert.equal(lock('mysql', 'mysql', 'share_nowait'), ' FOR SHARE NOWAIT');
  assert.equal(lock('mysql', 'mariadb', 'share_nowait'), ' LOCK IN SHARE MODE NOWAIT');
  assert.equal(lock('mysql', undefined, 'share_nowait'), ' FOR SHARE NOWAIT');
  assert.equal(lock('postgres', 'mysql', 'share'), ' FOR SHARE');
  assert.equal(lock('postgres', 'mysql', 'share_nowait'), ' FOR SHARE NOWAIT');
});

async function withReservedSqliteSession(file, exercise) {
  const directory = mkdtempSync(join(tmpdir(), 'orm-ts-sqlite-cancel-'));
  const dsn = `sqlite://${join(directory, file)}`;
  let pool;
  let session;
  const release = () => {
    session?.release();
    session = undefined;
  };
  try {
    pool = openDriver(dsn, parseDsn(dsn), { size: 1, idleSize: 1, lifetimeMs: 0 }, 16);
    session = await pool.reserve();
    await exercise(pool, release);
  } finally {
    release();
    try { await pool?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}

// Requirements: CFG-9. A pre-aborted SQLite statement does not wait behind a reserved connection.
caseTest('driver-cancel/sqlite/pre-aborted-while-queued', COMPUTE, async () => {
  await withReservedSqliteSession('pre-aborted.sqlite', async pool => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(pool.execute('SELECT 1', [], controller.signal, () => {}), error => error?.code === 'CANCELED');
    assert.equal(pool.stats().inUse, 1, 'cancellation must not release the held session');
  });
});

// Requirements: CFG-9. Aborting a queued SQLite statement removes its waiter without interrupting the holder.
caseTest('driver-cancel/sqlite/aborted-while-queued', COMPUTE, async () => {
  await withReservedSqliteSession('queued.sqlite', async (pool, release) => {
    const controller = new AbortController();
    const pending = pool.execute('SELECT 1', [], controller.signal, () => {});
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1, 'queued statement subscribes to cancellation');
    controller.abort();
    await assert.rejects(pending, error => error?.code === 'CANCELED');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'canceled waiter removes its listener');
    assert.equal(pool.stats().inUse, 1, 'cancellation must not release the held session');
    release();
    const result = await pool.execute('SELECT 1', [], undefined, () => {});
    assert.deepEqual(result.rows, [[1n]], 'pool remains usable after the holder releases');
  });
});
