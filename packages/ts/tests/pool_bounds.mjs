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
    const expected = dialect === 'sqlite' ? 1 : 3;
    const actual = configured.utils().stats().maxOpenConnections;
    if (actual !== expected) throw new Error(`${dialect}: poolSize 3 has maximum ${actual}, expected ${expected}`);
    step(`${dialect}: configured open connection maximum is ${actual}`);
  } finally {
    await configured.close();
  }

  for (const options of [{}, { poolSize: 0 }]) {
    const unset = await connect(dsn, options);
    try {
      const expected = dialect === 'sqlite' ? 1 : 10;
      const actual = unset.utils().stats().maxOpenConnections;
      if (actual !== expected) throw new Error(`${dialect}: poolSize ${JSON.stringify(options)} has maximum ${actual}, expected ${expected}`);
    } finally {
      await unset.close();
    }
  }
  step(`${dialect}: unset and zero use the declared default connection maximum`);

  if (dialect === 'sqlite') return;

  const bounded = await connect(dsn, { poolSize: 2 });
  let releaseConcurrent;
  let concurrentTasks = [];
  try {
    let active = 0;
    let peak = 0;
    let startedTwo;
    const twoStarted = new Promise(resolve => { startedTwo = resolve; });
    const gate = new Promise(resolve => { releaseConcurrent = resolve; });
    concurrentTasks = Array.from({ length: 6 }, () => bounded.transaction(async () => {
      active++;
      peak = Math.max(peak, active);
      if (active === 2) startedTwo();
      await gate;
      active--;
    }, { retry: 0 }));
    await twoStarted;
    const during = bounded.utils().stats();
    if (peak !== 2 || during.openConnections !== 2 || during.maxOpenConnections !== 2) {
      throw new Error(`${dialect}: poolSize 2 opened ${during.openConnections}/${during.maxOpenConnections}, peak transactions ${peak}`);
    }
    step(`${dialect}: concurrent transactions stop at the configured maximum of two`);
  } finally {
    releaseConcurrent?.();
    try { await Promise.all(concurrentTasks); } finally { await bounded.close(); }
  }

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

async function checkIdleLifetime(dialect, dsn, signal, step) {
  const idle = await connect(dsn, { poolSize: 3, poolIdleSize: 1 });
  let releaseIdle;
  let idleTasks = [];
  try {
    let started = 0;
    let allStarted;
    const threeStarted = new Promise(resolve => { allStarted = resolve; });
    const held = new Promise(resolve => { releaseIdle = resolve; });
    idleTasks = Array.from({ length: 3 }, () => idle.transaction(async () => {
      if (++started === 3) allStarted();
      await held;
    }, { retry: 0 }));
    await threeStarted;
    const during = idle.utils().stats();
    if (during.openConnections !== 3) throw new Error(`${dialect}: three held transactions opened ${during.openConnections} connections`);
    releaseIdle();
    await Promise.all(idleTasks);
    const after = idle.utils().stats();
    if (after.idle !== 1 || after.openConnections !== 1) {
      throw new Error(`${dialect}: idle size 1 retained ${after.idle} idle / ${after.openConnections} open connections`);
    }
    step(`${dialect}: releasing three connections retains only one idle connection`);
  } finally {
    releaseIdle?.();
    try { await Promise.all(idleTasks); } finally { await idle.close(); }
  }

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

// Requirements: CFG-4. Each dialect is an independent event so a failure in
// one case does not prevent the other native resource checks from running.
for (const dialect of ['sqlite', 'mysql', 'postgres']) {
  caseTest(`connection/pool-open-limit/${dialect}`, DATABASE, async ({ step }) => {
    await withCaseDatabase(dialect, step, database => checkConfiguredLimit(dialect, database.dsn, step));
  });
}

// Requirements: CFG-5. SQLite's single connection has no pool idle-size or
// lifetime behavior; MySQL and PostgreSQL execute these native pool checks.
for (const dialect of ['mysql', 'postgres']) {
  caseTest(`connection/pool-idle-lifetime/${dialect}`, DATABASE, async ({ signal, step }) => {
    await withCaseDatabase(dialect, step, database => checkIdleLifetime(dialect, database.dsn, signal, step));
  });
}
