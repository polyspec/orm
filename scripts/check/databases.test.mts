// Checks the binary log purge of the drop step (G5.55-2): when the replica did not apply the primary's binary log, the refusal
// names the replica's SQL thread state and its last error. A fake mysql on PATH stands for both servers; no database is used.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedEnvironment } from '../../tests/environment.mts';
import { caseTest } from '../../tests/testcase.mts';
import { purgeBinlogs } from './databases.mts';

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
