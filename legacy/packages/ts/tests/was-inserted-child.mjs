// The waiting side of was-inserted.mjs, backendWaitingForLock on PostgreSQL. It updates the row that the parent transaction
// holds, so it blocks until the parent ends its transaction, then prints "done".
// Usage: node was-inserted-child.mjs <postgres dsn> <seq>
import { postgresClient } from './case-database.mjs';

const [, , dsn, seq] = process.argv;
const client = postgresClient(dsn);
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(`UPDATE clock_event SET label = 'child' WHERE seq = ${Number(seq)}`);
  await client.query('COMMIT');
} finally {
  await client.end();
}
process.stdout.write('done\n');
