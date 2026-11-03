// The pool bounds of the TypeScript client as its driver pools read them. The refused DSNs are cases of contracts/fixtures/dsn_reject,
// and the sqlite-paths suite of tests/dsn/sqlite-paths.json is in dsn.mjs.
// Usage: node packages/ts/tests/dsn_features.mjs (after npm run typescript:build)
import { openDriver, parseDsn } from '../dist/driver.js';
import { cases, COMPUTE } from '../../../tests/testcase.mts';

const run = cases();
// Requirements: CFG-4, CFG-5. The pool bounds reach the driver pools, which open no connection before the first statement.
await run.run('dsn/pool-bounds', COMPUTE, async () => {
  const bounds = { size: 3, idleSize: 1, lifetimeMs: 250 };
  const postgres = openDriver('postgres://orm@127.0.0.1:1/orm', parseDsn('postgres://orm@127.0.0.1:1/orm'), bounds, 16);
  if (postgres.pool.options.max !== 3 || postgres.pool.options.maxLifetimeSeconds !== 0.25 || postgres.idleSize !== 1) throw new Error('postgres pool bounds were not applied');
  await postgres.close();
  const mysql = openDriver('mysql://orm@127.0.0.1:1/orm', parseDsn('mysql://orm@127.0.0.1:1/orm'), bounds, 16);
  if (mysql.pool.pool.config.connectionLimit !== 3 || mysql.pool.pool.listenerCount('release') !== 1 || mysql.pool.pool.listenerCount('connection') !== 2) throw new Error('mysql pool bounds were not applied');
  await mysql.close();
});
run.finish();
