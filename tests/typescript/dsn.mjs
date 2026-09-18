import { Db } from '../../clients/typescript/dist/index.js';
import { postgresZone } from '../../clients/typescript/dist/driver.js';

const schemaPath = new URL('../../schema/schema.json', import.meta.url).pathname;
for (const dsn of ['mysqlx://localhost/db', 'postgresql://localhost/db', 'sqlite://relative.db', 'localhost/db', 'mysql://root@localhost/app?timezone=Nowhere/City', 'sqlite:///tmp/x.sqlite?_txlock=immediate']) {
  let failed = false;
  try { await Db.connect(dsn, schemaPath); } catch (error) { failed = error?.code === 'CONFIG'; }
  if (!failed) throw new Error(`invalid DSN was accepted: ${dsn}`);
}
for (const [zone, posix] of [['+09:00', '<+09:00>-09:00'], ['-05:30', '<-05:30>+05:30'], ['+00:00', '<+00:00>-00:00'], ['Asia/Seoul', 'Asia/Seoul']]) {
  if (postgresZone(zone) !== posix) throw new Error(`postgres zone ${zone}: ${postgresZone(zone)}`);
}
console.log('typescript DSN validation passed');
