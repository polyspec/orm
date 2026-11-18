// Checks the binary log purge of the drop step (G5.55-2): when the replica did not apply the primary's binary log, the refusal
// names the replica's SQL thread state and its last error. A fake mysql on PATH stands for both servers; no database is used.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedEnvironment } from '../../tests/environment.mts';
import { caseTest } from '../../tests/testcase.mts';
import { decimalEnvironment, environmentFile, purgeBinlogs } from './databases.mts';

// The fake answers the statements of purgeBinlogs: the primary's position, the replica's wait, and the replica's status.
const FAKE_MYSQL = `#!/bin/sh
case "$*" in
  *"SHOW BINARY LOG STATUS"*) printf 'binlog.000075\\t158\\n' ;;
  *"SOURCE_POS_WAIT"*) printf 'NULL\\n' ;;
  *"SHOW REPLICA STATUS"*) printf 'Replica_IO_Running: Yes\\nReplica_SQL_Running: No\\nLast_SQL_Error: Error 1114 The table is full\\n' ;;
esac
exit 0
`;

caseTest('the drop refusal names the last error of the replica', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'drop-replica-')));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'mysql'), FAKE_MYSQL);
    chmodSync(join(bin, 'mysql'), 0o755);
    const servers = { ORM_RUN_MYSQL_DSN: 'mysql://root@127.0.0.1:1/orm_run', ORM_TEST_MYSQL_REPLICA_DSN: 'mysql://root@127.0.0.1:2/orm_test' };
    const env = isolatedEnvironment({ ...servers, PATH: `${bin}:${process.env.PATH ?? ''}` });
    const errors: string[] = [];
    const original = console.error;
    console.error = (...parts: unknown[]) => { errors.push(parts.join(' ')); };
    let purged: boolean;
    try {
      purged = purgeBinlogs('servers.env', servers, env);
    } finally {
      console.error = original;
    }
    assert.equal(purged, false);
    const text = errors.join('\n');
    assert.match(text, /SOURCE_POS_WAIT returned NULL/);
    assert.match(text, /Replica_SQL_Running: No/);
    assert.match(text, /Error 1114 The table is full/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// databases-create writes decimal-env from decimalEnvironment (T645): the DSNs of the decimal database of the run on the
// bench servers, and the SQLite file of the run directory, which the cleanup of the run removes with that directory.
caseTest('decimal-env names the decimal database of the run on each bench server and the SQLite file of its directory (T645)', () => {
  const text = decimalEnvironment('mysql://root@127.0.0.1:3306/orm_bench_run', 'postgres://orm@127.0.0.1:5432/orm_bench_run', 'orm_decimal_run', '/checkout/.runtime/run/kit-php-ext-4321-2');
  assert.deepEqual(environmentFile(text), {
    DECIMAL_MYSQL_DSN: 'mysql://root@127.0.0.1:3306/orm_decimal_run',
    DECIMAL_POSTGRES_DSN: 'postgres://orm@127.0.0.1:5432/orm_decimal_run',
    DECIMAL_SQLITE_DSN: 'sqlite:///checkout/.runtime/run/kit-php-ext-4321-2/decimal-case.sqlite?_pragma=busy_timeout(5000)&timezone=%2B00:00',
  });
});

// A create with an empty name is refused before it reads the servers file or calls a server (T645): databases-create of a
// caller that passes DIRECTORY but no NAME reaches it.
caseTest('databases.mts create refuses an empty name', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'empty-name-')));
  try {
    const refused = spawnSync(process.execPath, [join(import.meta.dirname, 'databases.mts'), 'create', join(dir, 'missing.env'), join(dir, 'run'), ''], { encoding: 'utf8', env: isolatedEnvironment({ PATH: join(dir, 'no-programs') }) });
    assert.equal(refused.status, 2, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /^databases: invalid name $/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
