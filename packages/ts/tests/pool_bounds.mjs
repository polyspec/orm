// CFG-4/CFG-5: verify the live connection and idle bounds of the TypeScript
// pools on SQLite, MySQL and PostgreSQL. Each dialect owns a fresh case DB.
import { connect } from '../dist/index.js';
import { caseTest, COMPUTE, DATABASE } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';

// Requirements: CFG-4, CFG-5. Valid DSN syntax is used so each failure proves
// the pool option validation ran before a driver connection was opened.
caseTest('connection/pool-invalid-options-refused', COMPUTE, async () => {
  const dsn = 'mysql://orm@127.0.0.1:1/orm';
  const cases = [
    [{ poolSize: -1 }, 'pool size must not be negative'],
    [{ poolIdleSize: -1 }, 'pool idle size must be between 0 and the pool size 10'],
    [{ poolSize: 3, poolIdleSize: 4 }, 'pool idle size must be between 0 and the pool size 3'],
    [{ poolIdleSize: 11 }, 'pool idle size must be between 0 and the pool size 10'],
    [{ poolLifetimeMs: -1 }, 'pool lifetime must not be negative'],
  ];
  for (const [options, message] of cases) {
    let failure;
    try { await connect(dsn, options); } catch (error) { failure = error; }
    if (failure?.code !== 'CONFIG' || !String(failure.message).includes(message)) {
      throw new Error(`${JSON.stringify(options)} failed with ${failure?.code ?? 'no error'}: ${failure?.message ?? ''}; expected CONFIG with ${message}`);
    }
  }
});

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

  for (const options of [{}, { poolSize: 0 }]) {
    const unset = await connect(dsn, options);
    try {
      const expected = 1;
      const actual = unset.utils().stats().maxOpenConnections;
      if (actual !== expected) throw new Error(`${dialect}: poolSize ${JSON.stringify(options)} has maximum ${actual}, expected ${expected}`);
    } finally {
      await unset.close();
    }
  }
  step(`${dialect}: unset and zero use the declared default connection maximum`);
}

function connectionRemoval(dialect, db, signal) {
  const driver = db.connection;
  const pool = dialect === 'mysql' ? driver.pool.pool : driver.pool;
  const connection = dialect === 'mysql' ? pool._freeConnections?.get?.(0) : pool;
  const event = dialect === 'mysql' ? 'end' : 'remove';
  if (typeof connection?.once !== 'function' || typeof connection?.removeListener !== 'function') {
    throw new Error(`${dialect}: native pool does not expose the ${event} event source`);
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      connection.removeListener(event, removed);
      signal.removeEventListener('abort', aborted);
    };
    const removed = () => { cleanup(); resolve(); };
    const aborted = () => { cleanup(); reject(signal.reason ?? new Error('pool lifetime observation was aborted')); };
    connection.once(event, removed);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

async function checkLifetime(dialect, dsn, signal, step) {
  const aged = await connect(dsn, { poolLifetimeMs: 1000 });
  try {
    const before = aged.utils().stats();
    if (before.openConnections !== 1 || before.idle !== 1) {
      throw new Error(`${dialect}: connect left ${before.openConnections} open / ${before.idle} idle connections before expiry`);
    }
    await connectionRemoval(dialect, aged, signal);
    const after = aged.utils().stats();
    if (after.openConnections !== 0 || after.idle !== 0) {
      throw new Error(`${dialect}: native pool removal left ${after.openConnections} open / ${after.idle} idle connections`);
    }
    step(`${dialect}: the pool remove/end event observes expiry at the configured lifetime`);
  } finally {
    await aged.close();
  }
}

// Requirements: CFG-4. The SQLite driver holds one connection whatever the pool size says; the recipe
// connection_pool states the pool of MySQL and PostgreSQL.
caseTest('connection/pool-open-limit/sqlite', DATABASE, async ({ step }) => {
  await withCaseDatabase('sqlite', step, database => checkConfiguredLimit('sqlite', database.dsn, step));
});

// Requirements: CFG-5. SQLite's single connection has no pool lifetime behavior; the expiry is observed from the
// remove or end event of the native pool, which no recipe value can state.
for (const dialect of ['mysql', 'postgres']) {
  caseTest(`connection/pool-lifetime/${dialect}`, DATABASE, async ({ signal, step }) => {
    await withCaseDatabase(dialect, step, database => checkLifetime(dialect, database.dsn, signal, step));
  });
}
