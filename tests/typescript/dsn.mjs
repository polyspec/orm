import { Db } from '../../clients/typescript/dist/index.js';
import { openDriver, parseDsn, postgresZone } from '../../clients/typescript/dist/driver.js';

const schemaPath = new URL('../../schema/schema.json', import.meta.url).pathname;
for (const dsn of ['mysqlx://localhost/db', 'postgresql://localhost/db', 'sqlite://relative.db', 'localhost/db', 'mysql://root@localhost/app?timezone=Nowhere/City', 'sqlite:///tmp/x.sqlite?_txlock=immediate', 'sqlite:///tmp/x.sqlite?_txlock=deferred', 'sqlite:///tmp/x.sqlite?_pragma=busy_timeout(soon)']) {
  let failed = false;
  try { await Db.connect(dsn, schemaPath); } catch (error) { failed = error?.code === 'CONFIG'; }
  if (!failed) throw new Error(`invalid DSN was accepted: ${dsn}`);
}
for (const [zone, posix] of [['+09:00', '<+09:00>-09:00'], ['-05:30', '<-05:30>+05:30'], ['+00:00', '<+00:00>-00:00'], ['Asia/Seoul', 'Asia/Seoul']]) {
  if (postgresZone(zone) !== posix) throw new Error(`postgres zone ${zone}: ${postgresZone(zone)}`);
}
for (const options of [{ poolIdleSize: -1 }, { poolSize: 3, poolIdleSize: 4 }, { poolIdleSize: 11 }, { poolLifetimeMs: -1 }]) {
  let failed = false;
  try { await Db.connect('sqlite:///tmp/orm-pool-options.sqlite', schemaPath, options); } catch (error) { failed = error?.code === 'CONFIG'; }
  if (!failed) throw new Error(`invalid pool options were accepted: ${JSON.stringify(options)}`);
}
// The pool bounds reach the driver pools, which open no connection before the first statement.
const bounds = { size: 3, idleSize: 1, lifetimeMs: 250 };
const postgres = openDriver('postgres://orm@127.0.0.1:1/orm', parseDsn('postgres://orm@127.0.0.1:1/orm'), bounds, 16);
if (postgres.pool.options.max !== 3 || postgres.pool.options.maxLifetimeSeconds !== 0.25 || postgres.idleSize !== 1) throw new Error('postgres pool bounds were not applied');
await postgres.close();
const mysql = openDriver('mysql://orm@127.0.0.1:1/orm', parseDsn('mysql://orm@127.0.0.1:1/orm'), bounds, 16);
if (mysql.pool.pool.config.connectionLimit !== 3 || mysql.pool.pool.listenerCount('release') !== 1 || mysql.pool.pool.listenerCount('connection') !== 2) throw new Error('mysql pool bounds were not applied');
await mysql.close();
console.log('typescript DSN validation passed');
