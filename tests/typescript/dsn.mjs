import { Db } from '../../clients/typescript/dist/index.js';

const options = { schemaHash: 'test', compiler: {} };
for (const dsn of ['mysqlx://localhost/db', 'postgresql://localhost/db', 'sqlite://relative.db', 'localhost/db']) {
  let failed = false;
  try { await Db.connect(dsn, options); } catch (error) { failed = error?.code === 'CONFIG'; }
  if (!failed) throw new Error(`invalid DSN was accepted: ${dsn}`);
}
console.log('typescript DSN validation passed');
