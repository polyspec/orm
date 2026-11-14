// The waiting side of was-inserted.mjs, backendWaitingForLock on PostgreSQL. It updates the row that the parent transaction
// holds, so it blocks until the parent ends its transaction, then prints "done". It prints "waiting" when the server reports
// that its update waits for the lock (reportLockWaits, T475).
// Usage: node was-inserted-child.mjs <postgres dsn> <seq>
import { postgresClient } from './case-database.mjs';
import { reportLockWaits } from './lock-wait.mjs';

const [, , dsn, seq] = process.argv;
const client = postgresClient(dsn);
await client.connect();
try {
  const nextWait = await reportLockWaits(client);
  await client.query('BEGIN');
  const waits = nextWait().then(() => process.stdout.write('waiting\n'));
  await client.query(`UPDATE clock_event SET label = 'child' WHERE seq = ${Number(seq)}`);
  await waits;
  await client.query('COMMIT');
} finally {
  await client.end();
}
process.stdout.write('done\n');
