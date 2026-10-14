// The bench databases of the physical tests: the three DSNs of TEST_ENV and the conformance lock that a test holds on them
// while it runs.
import { after } from 'node:test';
import { lockDatabases, releaseLocks } from './main.mts';

/** The bench databases and the variables of their DSNs. */
export const benchDatabases = [
  { driver: 'mysql', env: 'BENCH_MYSQL_DSN' },
  { driver: 'postgres', env: 'BENCH_POSTGRES_DSN' },
  { driver: 'sqlite', env: 'BENCH_SQLITE_DSN' },
];

/** benchDsn is the DSN of a bench database; it is required, so a test run outside its make target fails naming it. */
export function benchDsn(env: string): string {
  const dsn = process.env[env] ?? '';
  if (dsn === '') throw new Error(`${env} is required; run the test through its make target, which reads the environment of make test-servers`);
  return dsn;
}

/** lockBench holds the conformance lock of the three bench databases of TEST_ENV until the tests of the file end. */
export function lockBench(): void {
  lockDatabases(process.env.BENCH_MYSQL_DSN ?? '', process.env.BENCH_POSTGRES_DSN ?? '', process.env.BENCH_SQLITE_DSN ?? '');
  after(() => releaseLocks());
}
