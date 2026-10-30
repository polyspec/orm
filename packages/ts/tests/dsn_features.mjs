// The DSN feature tests of the TypeScript client: SQLite absolute paths, invalid DSNs, the UTC timezone, the pool bounds
// and the SQLite file name. The sqlite-paths suite of tests/dsn/sqlite-paths.json is in dsn.mjs.
// Usage: node packages/ts/tests/dsn_features.mjs (after npm run typescript:build)
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../dist/index.js';
import { openDriver, parseDsn } from '../dist/driver.js';
import { cases, COMPUTE } from '../../../tests/testcase.mts';

const run = cases();
// Requirements: CFG-26.
await run.run('dsn/sqlite-requires-absolute-path', COMPUTE, async () => {
  for (const dsn of ['sqlite://relative.sqlite', 'sqlite:///']) {
    let code = null;
    try { await Db.connect(dsn); } catch (error) { code = error?.code; }
    if (code !== 'CONFIG') throw new Error(`SQLite DSN ${dsn} returned ${code ?? 'no error'}, expected CONFIG`);
  }
  if (parseDsn('sqlite:///tmp/orm-example.sqlite').driver !== 'sqlite') throw new Error('absolute SQLite path was rejected');
});

// Requirements: CFG-2, CFG-19. A DSN of an unknown scheme, a relative SQLite path, a non-UTC timezone or an unsupported
// parameter value fails as CONFIG.
await run.run('dsn/invalid', COMPUTE, async () => {
  for (const dsn of ['mysqlx://localhost/db', 'postgresql://localhost/db', 'sqlite://relative.db', 'localhost/db', 'mysql://root@localhost/orm_example?timezone=Nowhere/City', 'sqlite:///tmp/x.sqlite?_txlock=immediate', 'sqlite:///tmp/x.sqlite?_txlock=deferred', 'sqlite:///tmp/x.sqlite?_pragma=busy_timeout(soon)']) {
    let failed = false;
    try { await Db.connect(dsn); } catch (error) { failed = error?.code === 'CONFIG'; }
    if (!failed) throw new Error(`invalid DSN was accepted: ${dsn}`);
  }
});
// Every connection reads and writes datetime as UTC, so the timezone accepts only UTC and +00:00.
// Requirements: CFG-2.
await run.run('dsn/timezone', COMPUTE, () => {
  for (const dsn of ['mysql://root@localhost/orm_example?timezone=%2B09:00', 'postgres://root@localhost/orm_example?timezone=Asia/Seoul', 'sqlite:///tmp/x.sqlite?timezone=Asia%2FSeoul']) {
    let failed = false;
    try { parseDsn(dsn); } catch (error) { failed = error?.code === 'CONFIG'; }
    if (!failed) throw new Error(`a non-UTC timezone was accepted: ${dsn}`);
  }
  for (const dsn of ['mysql://root@localhost/orm_example', 'postgres://root@localhost/orm_example?timezone=UTC', 'sqlite:///tmp/x.sqlite?timezone=%2B00:00']) {
    if (parseDsn(dsn).zone !== '+00:00') throw new Error(`connection zone of ${dsn}: ${parseDsn(dsn).zone}`);
  }
});
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
// A SQLite DSN with a query creates the file from the path alone. An opener that puts the query in the file name
// creates a file such as `named.sqlite?_pragma=…` (docs/spec/dialects.md "Probe environment").
await run.run('dsn/sqlite-file-name', COMPUTE, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orm-ts-sqlite-name-'));
  try {
    const named = await Db.connect(`sqlite://${directory}/named.sqlite?_pragma=busy_timeout(5000)&timezone=%2B00:00`);
    await named.close();
    const names = readdirSync(directory);
    const allowed = ['named.sqlite', 'named.sqlite-journal', 'named.sqlite-shm', 'named.sqlite-wal'];
    if (!names.includes('named.sqlite')) throw new Error(`files ${JSON.stringify(names)}: named.sqlite is missing`);
    for (const name of names) if (!allowed.includes(name)) throw new Error(`files ${JSON.stringify(names)}: ${name} is not named by the path`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
run.finish();
