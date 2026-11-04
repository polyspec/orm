// CFG-4: the TypeScript SQLite driver holds one connection whatever the pool size says, as no other
// runtime's does. The recipes connection_pool and dsn_reject_checked hold the pools of MySQL and PostgreSQL and the refused values.
import { connect } from '../dist/index.js';
import { caseTest, DATABASE } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';

async function checkConfiguredLimit(dialect, dsn, step) {
  const configured = await connect(dsn, { poolSize: 3 });
  try {
    const expected = 1;
    const actual = configured.utils().stats().maxOpenConnections;
    if (actual !== expected) throw new Error(`${dialect}: poolSize 3 has maximum ${actual}, expected ${expected}`);
    step(`${dialect}: configured open connection maximum is ${actual}`);
  } finally {
    await configured.close();
  }

  for (const options of [{}, { poolSize: 0 }, { poolSize: 3, poolIdleSize: 1, poolLifetimeMs: 1000 }]) {
    const unset = await connect(dsn, options);
    try {
      const expected = 1;
      const actual = unset.utils().stats().maxOpenConnections;
      if (actual !== expected) throw new Error(`${dialect}: poolSize ${JSON.stringify(options)} has maximum ${actual}, expected ${expected}`);
    } finally {
      await unset.close();
    }
  }
  step(`${dialect}: unset and zero use the declared default connection maximum, and the idle size and the lifetime change nothing`);
}

// Requirements: CFG-4, CFG-5. The SQLite driver holds one connection whatever the pool options say; the recipe
// connection_pool states the pool of MySQL and PostgreSQL.
caseTest('connection/pool-open-limit/sqlite', DATABASE, async ({ step }) => {
  await withCaseDatabase('sqlite', step, database => checkConfiguredLimit('sqlite', database.dsn, step));
});
